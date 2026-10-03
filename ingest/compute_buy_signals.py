"""Compute today's BUY signals using the v6 confluence formula and write
to signals_latest table — read source for the /signals page.

Formula (same as backtest v6):
  1. Insider cluster (Lakonishok-Lee)  0/1/2/3+ buyers in 30d → 0 / 1.5 / 3.5 / 7.0+
  2. 13F new (latest quarter)          Σ filer.multiplier × 2.0
  3. 13F add (latest quarter, ≥20%)    Σ filer.multiplier × 0.5
  4. Activist 13D (last 90d, initial)  Σ filer.multiplier × 5.0
  5. Raw share velocity (≥2x in Q)     Σ filer.multiplier × 2.0
  6. Cross-Q confluence (3+ filers)    Σ filer.multiplier × 1.5
  7. Multi-source pattern (≥3 types)   +5.0

Universe: market_cap ≥ $300M. No FOMO filter (per user direction).
Stores all signals with score ≥ 4 (~990 tickers); /signals page filters at read time.
"""
from __future__ import annotations

import os, re, sys, time, warnings
from datetime import date, datetime, timedelta, timezone
from collections import defaultdict
from pathlib import Path
from typing import Any

warnings.filterwarnings("ignore")

from supabase import Client, create_client
from dotenv import load_dotenv
import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def cik10(c): return str(int(c)).zfill(10)


def paginated(sb, table, sel, **filters):
    out, off = [], 0
    while True:
        q = sb.table(table).select(sel)
        for k, v in filters.items():
            q = q.eq(k, v)
        b = q.range(off, off + 999).execute()
        if not b.data:
            break
        out.extend(b.data)
        if len(b.data) < 1000:
            break
        off += 1000
    return out


SUFFIX_RE = re.compile(
    r"\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HLDGS|GROUP|GRP|LLC|LP|TRUST|N V|NV|SA|AG|TR|CL A|CL B|CLASS A|CLASS B|COM|ORD|ORDINARY|SHARES)\b\.?",
    re.I,
)
PUNCT_RE = re.compile(r"[.,&/\-\(\)\']")


def nm(s):
    if not s:
        return ""
    s = s.upper()
    s = PUNCT_RE.sub(" ", s)
    s = SUFFIX_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def main() -> None:
    import yfinance as yf

    AS_OF = date.today()
    sb = _supabase()
    print(f"Computing BUY signals as of {AS_OF}", flush=True)

    # ─── Filers + universe ──────────────────────────────────────────────
    # Per CLAUDE.md §2.4: weighting must be transparent. Final filer weight
    # = category multiplier × tier multiplier. Components remain visible
    # in the signal breakdown so the user can audit why a score fired.
    TIER_MULT = {"S": 1.5, "A": 1.2, "B": 1.0, "C": 0.7}
    with (PROJECT_ROOT / "config" / "tracked_filers.yml").open() as f:
        cfg = yaml.safe_load(f)
    FILER_MULT, FILER_NAME, FILER_TIER, FILER_BADGE = {}, {}, {}, {}
    for fl in cfg["filers"]:
        if not fl.get("cik"):
            continue
        c = cik10(fl["cik"])
        cat_mult = fl.get("multiplier", 1.0)
        tier = fl.get("tier", "B")
        tier_mult = TIER_MULT.get(tier, 1.0)
        FILER_MULT[c] = cat_mult * tier_mult
        FILER_NAME[c] = fl["name"]
        FILER_TIER[c] = tier
        FILER_BADGE[c] = fl.get("badge", "")
    print(f"  tracked filers: {len(FILER_MULT)} "
          f"(S={sum(1 for t in FILER_TIER.values() if t=='S')}, "
          f"A={sum(1 for t in FILER_TIER.values() if t=='A')}, "
          f"B={sum(1 for t in FILER_TIER.values() if t=='B')}, "
          f"C={sum(1 for t in FILER_TIER.values() if t=='C')})", flush=True)

    universe_rows = paginated(sb, "tickers", "ticker,name,market_cap_usd")
    universe = {r["ticker"]: r for r in universe_rows}
    name_to_ticker = {nm(u.get("name", "")): t for t, u in universe.items()}
    print(f"  universe: {len(universe)} tickers", flush=True)

    # ─── Filings + holdings ─────────────────────────────────────────────
    filings = paginated(sb, "filings_raw", "id,cik,form_type,filed_at,period_of_report")
    filed_at = {f["id"]: f["filed_at"][:10] for f in filings}
    window_end = AS_OF.isoformat()
    f13f = defaultdict(list)
    for f in filings:
        if f["form_type"] not in ("13F-HR", "13F-HR/A"):
            continue
        if f["filed_at"][:10] > window_end:
            continue
        c = cik10(f["cik"])
        if c in FILER_MULT:
            f13f[c].append(f)
    for c in f13f:
        f13f[c].sort(key=lambda x: (x.get("period_of_report") or "", x["filed_at"]))

    all_h = paginated(sb, "holdings_13f", "filing_id,ticker,shares,issuer_name")
    holdings = defaultdict(dict)
    for h in all_h:
        t = h.get("ticker") or name_to_ticker.get(nm(h.get("issuer_name", "")))
        if not t:
            continue
        holdings[h["filing_id"]][t] = holdings[h["filing_id"]].get(t, 0) + (h["shares"] or 0)

    # Trajectory + which filing contributed each event
    traj = {}  # (cik, t) -> [(period, shares, filed_at)]
    for c, fs in f13f.items():
        for f in sorted(fs, key=lambda x: x.get("period_of_report") or x["filed_at"]):
            for t, sh in holdings.get(f["id"], {}).items():
                traj.setdefault((c, t), []).append((f.get("period_of_report") or f["filed_at"][:10], sh, f["filed_at"][:10]))

    # ─── Insider cluster ────────────────────────────────────────────────
    window_ins_start = (AS_OF - timedelta(days=30)).isoformat()
    ins_tx = paginated(sb, "insider_transactions", "issuer_ticker,reporter_cik,transaction_date,filed_at,reporter_name,value_usd")
    ins_cluster = defaultdict(set)
    ins_dates = defaultdict(list)
    ins_meta = defaultdict(list)
    for r in ins_tx:
        t = r.get("issuer_ticker")
        if not t:
            continue
        td = r.get("transaction_date")
        if not td or td < window_ins_start or td > window_end:
            continue
        fa = (r.get("filed_at") or "")[:10]
        if not fa or fa > window_end:
            continue
        ins_cluster[t].add(r["reporter_cik"])
        ins_dates[t].append(fa)
        ins_meta[t].append({"name": r.get("reporter_name"), "value": r.get("value_usd"), "date": td})

    def s_insider(t):
        n = len(ins_cluster.get(t, set()))
        if n == 0: return 0.0
        if n == 1: return 1.5
        if n == 2: return 3.5
        return 7.0 + (n - 3) * 1.0

    # ─── 13F new / add / velocity ───────────────────────────────────────
    # Bug-fix May 2026: previously a filer's trajectory was treated as "new"
    # whenever len(tr)==1, regardless of how OLD that one position was — so
    # Druckenmiller's Q1 2024 NXE (long since exited) showed as a current "new"
    # signal in May 2026. Two filters added:
    #
    #   1) EXIT DETECTION — if the filer has filed a more recent 13F that does
    #      NOT contain this ticker, they exited. Skip them as a contributor.
    #
    #   2) RECENCY CUTOFF — even the filer's latest entry for this ticker
    #      must be within the last 180 days (≈2 quarters + filing buffer).
    #      Anything older means the trajectory is stale.
    #
    # Both filters apply to new/add/velocity AND cross-Q confluence below.
    filer_latest_period = {}
    for c, fs in f13f.items():
        periods = [f.get("period_of_report") or f["filed_at"][:10] for f in fs]
        if periods:
            filer_latest_period[c] = max(periods)

    RECENCY_CUTOFF = (AS_OF - timedelta(days=180)).isoformat()

    def is_stale(c, tr):
        """True iff this filer→ticker trajectory should be excluded as stale."""
        latest_period = tr[-1][0]
        # Filer has filed more recently without the ticker = they exited
        flp = filer_latest_period.get(c)
        if flp and flp > latest_period:
            return True
        # Even the latest entry is older than 180 days
        if latest_period < RECENCY_CUTOFF:
            return True
        return False

    new_pos = defaultdict(list)
    add_pos = defaultdict(list)
    velocity = defaultdict(list)
    contributing_filings = defaultdict(set)  # ticker -> set of filed_at dates contributing
    for (c, t), tr in traj.items():
        if t not in universe:
            continue
        if is_stale(c, tr):
            continue
        mult = FILER_MULT[c]
        latest = tr[-1]
        if len(tr) == 1:
            new_pos[t].append((c, mult))
            contributing_filings[t].add(latest[2])
        else:
            cur, prev = tr[-1], tr[-2]
            if cur[1] and prev[1]:
                r = cur[1] / prev[1]
                if r > 1.2:
                    add_pos[t].append((c, mult))
                    contributing_filings[t].add(cur[2])
                if r >= 2.0:
                    velocity[t].append((c, mult, round(r, 1)))
                    contributing_filings[t].add(cur[2])

    def s_new(t): return sum(m for _, m in new_pos.get(t, [])) * 2.0
    def s_add(t): return sum(m for _, m in add_pos.get(t, [])) * 0.5
    def s_vel(t): return sum(m for _, m, _ in velocity.get(t, [])) * 2.0

    # ─── 13D activist ───────────────────────────────────────────────────
    window_13d_start = (AS_OF - timedelta(days=90)).isoformat()
    e13d = paginated(sb, "events_13d", "ticker,cik,form_subtype,filing_id,issuer_name")
    act_13d = defaultdict(list)
    for r in e13d:
        t = r.get("ticker") or name_to_ticker.get(nm(r.get("issuer_name", "")))
        if not t or r["form_subtype"] not in ("13D", "SCHEDULE 13D"):
            continue
        fa = filed_at.get(r["filing_id"])
        if not fa or fa > window_end or fa < window_13d_start:
            continue
        c = cik10(r["cik"])
        if c in FILER_MULT:
            act_13d[t].append((c, FILER_MULT[c]))
            contributing_filings[t].add(fa)

    def s_13d(t): return sum(m for _, m in act_13d.get(t, [])) * 5.0

    # ─── Cross-Q confluence ─────────────────────────────────────────────
    # Same staleness filter as new/add — a filer who initiated in some quarter
    # but has since exited shouldn't count for cross-Q confluence either.
    all_periods = sorted({tr[-1][0] for tr in traj.values()}, reverse=True)
    lp = all_periods[0] if all_periods else None
    pp = all_periods[1] if len(all_periods) > 1 else None
    iq1, iq2 = defaultdict(list), defaultdict(list)
    for (c, t), tr in traj.items():
        if t not in universe:
            continue
        if is_stale(c, tr):
            continue
        earliest = tr[0][0]
        if earliest == lp:
            iq1[t].append((c, FILER_MULT[c]))
        elif earliest == pp:
            iq2[t].append((c, FILER_MULT[c]))

    def s_xq(t):
        combined = {c for c, _ in iq1.get(t, [])} | {c for c, _ in iq2.get(t, [])}
        return sum(FILER_MULT[c] for c in combined) * 1.5 if len(combined) >= 3 else 0.0

    # ─── Multi-source pattern bonus ─────────────────────────────────────
    def s_pat(t):
        types = sum([
            len(ins_cluster.get(t, set())) >= 2,
            len(new_pos.get(t, [])) >= 1 or len(add_pos.get(t, [])) >= 1,
            len(act_13d.get(t, [])) >= 1,
            len(velocity.get(t, [])) >= 1,
            len({c for c, _ in iq1.get(t, [])} | {c for c, _ in iq2.get(t, [])}) >= 3,
        ])
        return (5.0 if types >= 3 else 0.0, types)

    # ─── Score all tickers ──────────────────────────────────────────────
    all_t = set(ins_cluster) | set(new_pos) | set(add_pos) | set(act_13d) | set(velocity) | set(iq1) | set(iq2)
    scored: list[dict[str, Any]] = []
    for t in all_t:
        if t not in universe: continue
        if (universe[t].get("market_cap_usd") or 0) < 300_000_000: continue
        ins_score = s_insider(t)
        n_score = s_new(t)
        a_score = s_add(t)
        d13_score = s_13d(t)
        vel_score = s_vel(t)
        xq_score = s_xq(t)
        pat_score, n_types = s_pat(t)
        total = ins_score + n_score + a_score + d13_score + vel_score + xq_score + pat_score
        if total < 4.0:
            continue

        # Dates
        fdates = list(contributing_filings.get(t, set())) + ins_dates.get(t, [])
        first_detected = min(fdates) if fdates else None
        latest_signal = max(fdates) if fdates else None

        # Components JSON (transparent breakdown per §2.4)
        components = {
            "insider_cluster": {"n": len(ins_cluster.get(t, set())), "score": round(ins_score, 2)},
            "thirteenf_new": {"n": len(new_pos.get(t, [])), "score": round(n_score, 2)},
            "thirteenf_add": {"n": len(add_pos.get(t, [])), "score": round(a_score, 2)},
            "activist_13d": {"n": len(act_13d.get(t, [])), "score": round(d13_score, 2)},
            "share_velocity": {"n": len(velocity.get(t, [])), "score": round(vel_score, 2)},
            "cross_q_confluence": {"n": len({c for c, _ in iq1.get(t, [])} | {c for c, _ in iq2.get(t, [])}), "score": round(xq_score, 2)},
            "multi_source_bonus": {"applied": pat_score > 0, "n_types": n_types, "score": round(pat_score, 2)},
        }

        contributing_filers = {
            "new": [FILER_NAME.get(c, c) for c, _ in new_pos.get(t, [])][:5],
            "add": [FILER_NAME.get(c, c) for c, _ in add_pos.get(t, [])][:5],
            "velocity": [(FILER_NAME.get(c, c), r) for c, _, r in velocity.get(t, [])][:5],
            "activist": [FILER_NAME.get(c, c) for c, _ in act_13d.get(t, [])][:3],
            "insider_buyers": [m["name"] for m in ins_meta.get(t, [])][:5],
        }

        scored.append({
            "ticker": t,
            "score": round(total, 2),
            "num_sources": n_types,
            "components": components,
            "contributing_filers": contributing_filers,
            "first_detected_at": first_detected,
            "latest_signal_at": latest_signal,
            "aum_usd": universe[t].get("market_cap_usd"),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    print(f"  Scored picks (≥4): {len(scored)}", flush=True)

    # ─── Fetch returns for each (top 200 to keep runtime reasonable) ─────
    print("Fetching returns…", flush=True)
    Y_START_OF_YEAR = date(AS_OF.year, 1, 1)
    for i, s in enumerate(scored[:200], 1):
        try:
            t_obj = yf.Ticker(s["ticker"])
            hist = t_obj.history(period="1y", auto_adjust=True)
            if hist.empty or len(hist) < 2:
                continue
            idx = hist.index.tz_localize(None) if hist.index.tz else hist.index
            today_close = float(hist["Close"].iloc[-1])
            s["price"] = round(today_close, 2)
            def ret_at_days(n):
                if len(hist) < n + 1: return None
                p = float(hist["Close"].iloc[-(n + 1)])
                return round((today_close - p) / p * 100, 2) if p > 0 else None
            s["return_1m"] = ret_at_days(21)
            s["return_6m"] = ret_at_days(126)
            # YTD: find close at start of year
            ytd_match = idx[idx >= datetime.combine(Y_START_OF_YEAR, datetime.min.time())]
            if len(ytd_match) > 0:
                ytd_close = float(hist.loc[idx == ytd_match[0], "Close"].iloc[0])
                if ytd_close > 0:
                    s["return_ytd"] = round((today_close - ytd_close) / ytd_close * 100, 2)
        except Exception:
            pass
        time.sleep(0.3)
        if i % 25 == 0:
            print(f"    {i}/{min(200, len(scored))}", flush=True)

    # ─── Wipe + upsert ──────────────────────────────────────────────────
    print(f"\nUpserting {len(scored)} signals…", flush=True)
    # Clear stale rows first (tickers no longer signaling)
    current_tickers = {s["ticker"] for s in scored}
    existing = sb.table("signals_latest").select("ticker").execute()
    to_delete = [r["ticker"] for r in (existing.data or []) if r["ticker"] not in current_tickers]
    if to_delete:
        print(f"  Removing {len(to_delete)} stale tickers", flush=True)
        sb.table("signals_latest").delete().in_("ticker", to_delete).execute()
    # Upsert current. computed_at's column default (now()) only fires on
    # INSERT, so stamp it explicitly — otherwise a ticker that keeps
    # signaling shows the date it FIRST appeared as "last computed".
    run_at = datetime.now(timezone.utc).isoformat()
    for s in scored:
        s["computed_at"] = run_at
    for i in range(0, len(scored), 100):
        batch = scored[i:i + 100]
        sb.table("signals_latest").upsert(batch, on_conflict="ticker").execute()
    print("Done.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
