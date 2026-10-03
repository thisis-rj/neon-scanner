"""Replay the BUY-signal scorer against a frozen snapshot and diff the results.

Why: scoring changes must move only the tickers they are meant to move
(eng-review regression contract R4). Running two versions of
ingest/compute_buy_signals.py against the *same* input snapshot gives an
exact, deterministic diff, with no writes to production.

  # 1. Freeze the scorer's inputs (read-only).
  python scripts/diff_signals.py snapshot --out /tmp/neon-snap.json.gz

  # 2. Replay any git ref (or the uncommitted working tree) against it.
  python scripts/diff_signals.py replay /tmp/neon-snap.json.gz --ref HEAD~1 --out /tmp/old.json
  python scripts/diff_signals.py replay /tmp/neon-snap.json.gz --ref WORKTREE --out /tmp/new.json

  # 3. Compare. Exit code 1 if anything differs.
  python scripts/diff_signals.py compare /tmp/old.json /tmp/new.json

  # 3b. With --snapshot, each changed ticker is attributed to the causes the
  #     eng-review plan expects (options, bond principal, 13F amendments,
  #     insider buys in the window).
  #     Exit code 1 only if some change has no cause (UNATTRIBUTED).
  python scripts/diff_signals.py compare /tmp/old.json /tmp/new.json --snapshot /tmp/post.json.gz

Replay swaps in a fake Supabase client (serves the snapshot, records the
upsert instead of sending it), disables yfinance price enrichment, and pins
"today" to the snapshot date. The snapshot holds public SEC data only; keep
it outside the repo anyway.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Tables the scorer reads. Columns cover today's scorer plus the fields the
# eng-review plan adds (put_call, sh_type, amendment_type, ...); missing
# columns are skipped so older databases still snapshot.
SNAPSHOT_TABLES = {
    "tickers": "*",
    "filings_raw": "id,cik,form_type,filed_at,period_of_report,amendment_type",
    "holdings_13f": "filing_id,cik,period_of_report,cusip,ticker,issuer_name,shares,value_usd,put_call,sh_type",
    "holdings_13f_effective": "filing_id,cik,period_of_report,cusip,ticker,issuer_name,shares,value_usd,put_call,sh_type",
    "insider_transactions": "*",
    "events_13d": "ticker,cik,form_subtype,filing_id,issuer_name",
}


# ─── snapshot ───────────────────────────────────────────────────────────

def _fetch_all(sb, table: str, cols: str) -> list[dict]:
    out, off = [], 0
    while True:
        b = sb.table(table).select(cols).order("id" if table != "tickers" else "ticker").range(off, off + 999).execute()
        out.extend(b.data or [])
        if not b.data or len(b.data) < 1000:
            return out
        off += 1000


def cmd_snapshot(args) -> int:
    from dotenv import load_dotenv
    from supabase import create_client

    load_dotenv(REPO / ".env")
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    snap = {"as_of": date.today().isoformat(), "tables": {}}
    for table, cols in SNAPSHOT_TABLES.items():
        try:
            rows = _fetch_all(sb, table, cols)
        except Exception as e:  # missing column, or a table/view not created yet
            reduced = _drop_unknown_cols(sb, table, cols)
            if reduced is None:
                print(f"  {table}: skipped ({str(e)[:80]})", flush=True)
                continue
            rows = _fetch_all(sb, table, reduced)
        snap["tables"][table] = rows
        print(f"  {table}: {len(rows):,} rows", flush=True)
    with gzip.open(args.out, "wt") as f:
        json.dump(snap, f)
    print(f"Snapshot as of {snap['as_of']} → {args.out}")
    return 0


def _drop_unknown_cols(sb, table: str, cols: str) -> str | None:
    """Return `cols` minus the columns this database doesn't have yet (None if nothing changes)."""
    if cols == "*":
        return None
    keep = []
    for c in cols.split(","):
        try:
            sb.table(table).select(c).limit(1).execute()
            keep.append(c)
        except Exception:
            pass
    reduced = ",".join(keep)
    return reduced if keep and reduced != cols else None


# ─── replay ─────────────────────────────────────────────────────────────

def cmd_replay(args) -> int:
    tmp = Path(tempfile.mkdtemp(prefix="neon-replay-"))
    try:
        if args.ref == "WORKTREE":
            for d in ("ingest", "config"):
                shutil.copytree(REPO / d, tmp / d, ignore=shutil.ignore_patterns("__pycache__"))
        else:
            archive = subprocess.run(
                ["git", "-C", str(REPO), "archive", args.ref, "ingest", "config"],
                check=True, capture_output=True,
            ).stdout
            subprocess.run(["tar", "-x", "-C", str(tmp)], input=archive, check=True)
        env = {**os.environ, "PYTHONPATH": str(tmp),
               "SUPABASE_URL": "http://replay.invalid", "SUPABASE_SECRET_KEY": "replay"}
        r = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "_run", str(Path(args.snapshot).resolve()),
             str(Path(args.out).resolve())],
            cwd=tmp, env=env,
        )
        return r.returncode
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class _Result:
    def __init__(self, data): self.data = data


class _Query:
    def __init__(self, client, table):
        self.client, self.table, self.filters, self.lo, self.hi = client, table, [], None, None
        self.op, self.payload = "select", None

    def select(self, *_a, **_k): return self
    def order(self, *_a, **_k): return self
    def limit(self, n): self.lo, self.hi = 0, n - 1; return self
    def eq(self, k, v): self.filters.append((k, v)); return self
    def in_(self, k, vs): self.filters.append((k, set(vs))); return self
    def range(self, lo, hi): self.lo, self.hi = lo, hi; return self
    def delete(self): self.op = "delete"; return self
    def upsert(self, rows, **_k): self.op, self.payload = "upsert", rows; return self
    def insert(self, rows, **_k): self.op, self.payload = "upsert", rows; return self

    def execute(self):
        if self.op == "upsert":
            self.client.writes.setdefault(self.table, []).extend(self.payload)
            return _Result(self.payload)
        if self.op == "delete":
            return _Result([])
        if self.table not in self.client.tables:
            raise RuntimeError(f"replay: table {self.table!r} not in snapshot")
        rows = self.client.tables[self.table]
        for k, v in self.filters:
            rows = [r for r in rows if (r.get(k) in v if isinstance(v, set) else r.get(k) == v)]
        if self.lo is not None:
            rows = rows[self.lo:self.hi + 1]
        return _Result(rows)


class _FakeClient:
    def __init__(self, tables):
        self.tables = dict(tables)
        self.tables.setdefault("signals_latest", [])
        self.writes: dict[str, list] = {}

    def table(self, name): return _Query(self, name)


def _run(snapshot_path: str, out_path: str) -> int:
    with gzip.open(snapshot_path, "rt") as f:
        snap = json.load(f)
    as_of = date.fromisoformat(snap["as_of"])

    fake_yf = types.ModuleType("yfinance")

    class _NoPrices:
        def __init__(self, *_a, **_k): pass
        def history(self, *_a, **_k): raise RuntimeError("prices disabled in replay")

    fake_yf.Ticker = _NoPrices
    sys.modules["yfinance"] = fake_yf

    import ingest.compute_buy_signals as mod

    class _PinnedDate(date):
        @classmethod
        def today(cls): return as_of

    client = _FakeClient(snap["tables"])
    mod._supabase = lambda: client
    mod.date = _PinnedDate
    mod.time = types.SimpleNamespace(sleep=lambda *_a: None)
    mod.main()

    rows = client.writes.get("signals_latest", [])
    out = {r["ticker"]: {k: v for k, v in r.items() if k != "computed_at"} for r in rows}
    Path(out_path).write_text(json.dumps({"as_of": snap["as_of"], "signals": out}, indent=1, sort_keys=True, default=str))
    print(f"Replayed {len(out)} signals → {out_path}")
    return 0


# ─── compare ────────────────────────────────────────────────────────────

def causes_by_ticker(snap: dict) -> dict[str, set[str]]:
    """ticker → which planned changes touch it: 'options', 'bonds', 'amendment', 'insiders'.

    'insiders' = the ticker has insider buys in the scorer's 30-day window, so
    the insider filters (or corrected role flags) can move it.

    Tickers are resolved the way the scorer does (row ticker, else issuer-name
    match against the universe). 'amendment' = a row from a 13F-HR/A, or a
    share row the view dropped because a later filing superseded its filing.
    """
    sys.path.insert(0, str(REPO))
    from ingest.scoring_rules import nm

    t = snap["tables"]
    name_to_ticker = {nm(u.get("name", "")): u["ticker"] for u in t["tickers"]}
    form = {f["id"]: f["form_type"] for f in t["filings_raw"]}
    effective_filings = {r["filing_id"] for r in t.get("holdings_13f_effective", [])}
    causes: dict[str, set[str]] = {}
    for r in t["holdings_13f"]:
        tk = r.get("ticker") or name_to_ticker.get(nm(r.get("issuer_name", "")))
        if not tk:
            continue
        c = causes.setdefault(tk, set())
        if r.get("put_call"):
            c.add("options")
        elif r.get("sh_type") == "PRN":
            c.add("bonds")
        elif form.get(r["filing_id"]) == "13F-HR/A" or r["filing_id"] not in effective_filings:
            c.add("amendment")
    from datetime import timedelta
    as_of = date.fromisoformat(snap["as_of"])
    start, end = (as_of - timedelta(days=30)).isoformat(), as_of.isoformat()
    for r in t.get("insider_transactions", []):
        if r.get("issuer_ticker") and start <= (r.get("transaction_date") or "") <= end:
            causes.setdefault(r["issuer_ticker"], set()).add("insiders")
    return causes


def cmd_compare(args) -> int:
    a = json.loads(Path(args.before).read_text())["signals"]
    b = json.loads(Path(args.after).read_text())["signals"]
    removed = sorted(set(a) - set(b))
    added = sorted(set(b) - set(a))
    changed = sorted(t for t in set(a) & set(b) if a[t] != b[t])
    causes = None
    if args.snapshot:
        with gzip.open(args.snapshot, "rt") as f:
            causes = causes_by_ticker(json.load(f))

    def why(t):
        if causes is None:
            return ""
        c = sorted(causes.get(t, set()))
        return f"  [{', '.join(c)}]" if c else "  [UNATTRIBUTED]"

    print(f"before={len(a)} after={len(b)} | added={len(added)} removed={len(removed)} changed={len(changed)}")
    for t in removed:
        print(f"  - {t:8s} score {a[t]['score']}{why(t)}")
    for t in added:
        print(f"  + {t:8s} score {b[t]['score']}{why(t)}")
    for t in changed:
        diffs = [k for k in sorted(set(a[t]) | set(b[t])) if a[t].get(k) != b[t].get(k)]
        print(f"  ~ {t:8s} score {a[t]['score']} → {b[t]['score']}  fields: {', '.join(diffs)}{why(t)}")
    touched = removed + added + changed
    if causes is not None:
        tally: dict[str, int] = {}
        for t in touched:
            for c in causes.get(t) or {"UNATTRIBUTED"}:
                tally[c] = tally.get(c, 0) + 1
        print("causes: " + ", ".join(f"{k}={v}" for k, v in sorted(tally.items())))
        return 1 if tally.get("UNATTRIBUTED") else 0
    return 1 if touched else 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "_run":
        return _run(sys.argv[2], sys.argv[3])
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot"); s.add_argument("--out", required=True)
    r = sub.add_parser("replay"); r.add_argument("snapshot"); r.add_argument("--ref", default="WORKTREE"); r.add_argument("--out", required=True)
    c = sub.add_parser("compare"); c.add_argument("before"); c.add_argument("after"); c.add_argument("--snapshot")
    args = p.parse_args()
    return {"snapshot": cmd_snapshot, "replay": cmd_replay, "compare": cmd_compare}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
