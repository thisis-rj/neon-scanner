"""Lag7 — Mag7 laggard sleeve: month-end signal + model sleeve tracker (no execution).

Rule (CLAUDE.md §2.2 note on personal strategy trackers):
  - At each month-end close, compute trailing 3 / 6 / 12-month total return
    (dividend-adjusted closes, month-end to month-end) for the Mag7 + newcomers.
  - Rank each horizon (1 = highest return) among the stocks that HAVE that
    horizon. Average the ranks each stock has.
  - Buy the WORST average rank (the laggard); tie → lower return on the
    longest horizon each tied stock has (12-month, else 6, else 3).
  - The sleeve starts 2025-01-01: the first signal is the 2024-12-31 close and
    the first buy is 2025-01-02. Earlier month-ends are never computed.
  - Newcomers (SpaceX, listed 2026-06-12) join a signal once they have a
    3-month return, ranked "on what they have" until 6/12 months exist.
  - On the first trading day after the signal, the $100,000 model sleeve
    switches into the pick at that day's close (or holds if unchanged).
    No outside capital is ever added; proceeds roll into the next pick.

Frozen history: signals, ranks and model trades are written once and never
rewritten, so the page never changes what it told you. A signal is 'live' only
if it was saved before its trade day closed (i.e. you could have acted on it);
everything else — the initial backfill, or a late run — is 'backtest'.

The sleeve is valued by growing each buy's dollar amount with the stock's
adjusted-close ratio (not shares × price), so dividends count and Yahoo's
retroactive dividend re-scaling can't skew stored history.

Real fills live separately in mag7_actual_trades (typed in on the page).

Usage:
  python -m ingest.mag7             # update Supabase
  python -m ingest.mag7 --dry-run   # compute from scratch, print, write nothing
"""
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]  # core: must all be priced
NEWCOMERS = ["SPCX"]  # SpaceX; ranked from its first 3-month return, on the horizons it has
UNIVERSE = TICKERS + NEWCOMERS
BENCHMARK = "^SP500TR"  # S&P 500 total return (dividends reinvested), like the stocks' adjusted closes
START_CAPITAL = 100_000.0
HORIZONS = (3, 6, 12)
SLEEVE_START = date(2025, 1, 1)  # first trade on/after this date
PRICE_HISTORY_START = "2023-06-01"  # 12 months of returns before the 2024-12-31 signal, plus slack


# ── Pure logic (tested in tests/test_mag7.py) ─────────────────────────────────

def month_ends(closes: pd.DataFrame, today: date) -> list[pd.Timestamp]:
    """Last trading day of each COMPLETED month (months before `today`'s month)."""
    idx = closes.index
    last = pd.Series(idx, index=idx).groupby([idx.year, idx.month]).max()
    cutoff = pd.Timestamp(today.year, today.month, 1)
    return [d for d in last.tolist() if d < cutoff]


def _ret(closes: pd.DataFrame, t: str, now: pd.Timestamp, then: pd.Timestamp) -> float:
    if t not in closes:
        return float("nan")
    return closes.at[now, t] / closes.at[then, t] - 1


def compute_signal(closes: pd.DataFrame, ends: list[pd.Timestamp], i: int) -> dict | None:
    """Ranking table + pick for month-end ends[i]; None if a core input is missing.

    Core tickers need all three horizons. A newcomer is included once it has a
    3-month return; its missing horizons stay NaN and are left out of its
    rank and average."""
    if i < max(HORIZONS):
        return None
    rows = {}
    for t in UNIVERSE:
        r = {f"ret_{h}m": _ret(closes, t, ends[i], ends[i - h]) for h in HORIZONS}
        if t in TICKERS and any(pd.isna(v) for v in r.values()):
            return None
        if pd.isna(r["ret_3m"]):
            continue  # newcomer without a 3-month return yet
        rows[t] = r
    df = pd.DataFrame.from_dict(rows, orient="index")
    for h in HORIZONS:
        df[f"rank_{h}m"] = df[f"ret_{h}m"].rank(ascending=False, method="min").astype("Int64")
    df["avg_rank"] = df[[f"rank_{h}m" for h in HORIZONS]].astype(float).mean(axis=1, skipna=True)
    # Laggard rule: worst (highest) average rank first; tie → lower return on
    # the longest horizon each stock has.
    df["_tie"] = df["ret_12m"].fillna(df["ret_6m"]).fillna(df["ret_3m"])
    order = df.sort_values(["avg_rank", "_tie"], ascending=[False, True]).drop(columns="_tie")
    return {"signal_date": ends[i].date(), "selected": order.index[0], "ranks": order}


def next_trading_day(closes: pd.DataFrame, after: date) -> date | None:
    later = closes.index[closes.index > pd.Timestamp(after)]
    return later[0].date() if len(later) else None


@dataclass
class Position:
    """The model sleeve's single holding: dollar amount invested at buy_date."""
    ticker: str | None = None
    buy_date: date | None = None
    amount: float = START_CAPITAL  # cash before the first buy


def value_on(pos: Position, closes: pd.DataFrame, d: date) -> float:
    if pos.ticker is None:
        return pos.amount
    return pos.amount * closes.at[pd.Timestamp(d), pos.ticker] / closes.at[pd.Timestamp(pos.buy_date), pos.ticker]


def rebalance(pos: Position, selected: str, trade_date: date, signal_date: date,
              closes: pd.DataFrame) -> tuple[Position, list[dict], str]:
    """Apply one signal. Returns (new position, trade rows, action)."""
    def px(t: str) -> float:
        return float(closes.at[pd.Timestamp(trade_date), t])

    def row(side: str, t: str, amount: float) -> dict:
        p = px(t)
        return {"trade_date": trade_date, "signal_date": signal_date, "side": side,
                "ticker": t, "shares": round(amount / p, 6), "price": round(p, 4),
                "amount": round(amount, 2)}

    if pos.ticker == selected:
        return pos, [], "hold"
    trades = []
    action = "initial" if pos.ticker is None else "switch"
    proceeds = value_on(pos, closes, trade_date)
    if pos.ticker is not None:
        trades.append(row("sell", pos.ticker, proceeds))
    trades.append(row("buy", selected, proceeds))
    return Position(selected, trade_date, proceeds), trades, action


def position_from_trades(trades: list[dict]) -> Position:
    """Replay the stored ledger: the last buy is the current holding."""
    buys = sorted((t for t in trades if t["side"] == "buy"), key=lambda t: str(t["trade_date"]))
    if not buys:
        return Position()
    b = buys[-1]
    return Position(b["ticker"], date.fromisoformat(str(b["trade_date"])), float(b["amount"]))


def position_on(trades: list[dict], d: date) -> Position:
    return position_from_trades([t for t in trades if date.fromisoformat(str(t["trade_date"])) <= d])


def equity_rows(trades: list[dict], closes: pd.DataFrame, ends: list[pd.Timestamp]) -> list[dict]:
    """Sleeve vs equal-weight-7 vs S&P 500 TR at each month-end since the first trade, plus the latest day."""
    buys = sorted((t for t in trades if t["side"] == "buy"), key=lambda t: str(t["trade_date"]))
    if not buys:
        return []
    start = pd.Timestamp(str(buys[0]["trade_date"]))
    base = closes.loc[start]
    latest = closes.index[-1]
    dates = [d for d in ends if d >= start]
    kinds = {d: "month_end" for d in dates}
    if latest not in kinds:
        dates.append(latest)
        kinds[latest] = "latest"
    rows = []
    for d in dates:
        c = closes.loc[d]
        if c[TICKERS + [BENCHMARK]].isna().any():
            continue
        rows.append({
            "date": d.date(),
            "kind": kinds[d],
            "strategy": round(value_on(position_on(trades, d.date()), closes, d.date()), 2),
            "equal_weight": round(sum(START_CAPITAL / len(TICKERS) * c[t] / base[t] for t in TICKERS), 2),
            "sp500": round(START_CAPITAL * c[BENCHMARK] / base[BENCHMARK], 2),
            "closes": {t: round(float(c[t]), 4) for t in UNIVERSE + [BENCHMARK]
                       if t in c and pd.notna(c[t])},
        })
    return rows


@dataclass
class Plan:
    """What one run should write."""
    new_signals: list[dict] = field(default_factory=list)       # {signal_date, selected, source, ranks}
    filled: list[dict] = field(default_factory=list)            # {signal_date, trade_date, action}
    new_trades: list[dict] = field(default_factory=list)
    equity: list[dict] = field(default_factory=list)


def plan_run(closes: pd.DataFrame, today: date, stored_signals: list[dict],
             stored_trades: list[dict], sleeve_start: date = SLEEVE_START) -> Plan:
    """Decide every write for this run given what's already stored. Never rewrites stored rows.

    Only signals whose trade day falls on/after `sleeve_start` exist (a signal
    whose trade day isn't known yet is always kept)."""
    plan = Plan()
    ends = month_ends(closes, today)
    known = {str(s["signal_date"]) for s in stored_signals}

    for i in range(len(ends)):
        if str(ends[i].date()) in known:
            continue
        td = next_trading_day(closes, ends[i].date())
        if td is not None and td < sleeve_start:
            continue
        sig = compute_signal(closes, ends, i)
        if sig is None:
            continue
        sig["source"] = "live" if next_trading_day(closes, sig["signal_date"]) is None else "backtest"
        plan.new_signals.append(sig)

    signals = sorted(
        [{"signal_date": date.fromisoformat(str(s["signal_date"])), "selected": s["selected"],
          "action": s.get("action")} for s in stored_signals]
        + [{"signal_date": s["signal_date"], "selected": s["selected"], "action": None}
           for s in plan.new_signals],
        key=lambda s: s["signal_date"],
    )
    trades = list(stored_trades)
    pos = position_from_trades(trades)
    for s in signals:
        if s["action"] is not None:
            continue
        td = next_trading_day(closes, s["signal_date"])
        if td is None or closes.loc[pd.Timestamp(td), TICKERS + [s["selected"]]].isna().any():
            break  # later signals can't be filled before this one
        pos, rows, action = rebalance(pos, s["selected"], td, s["signal_date"], closes)
        trades += rows
        plan.new_trades += rows
        plan.filled.append({"signal_date": s["signal_date"], "trade_date": td, "action": action})

    plan.equity = equity_rows(trades, closes, ends)
    return plan


# ── IO ────────────────────────────────────────────────────────────────────────

def _closes_from_chart_api() -> pd.DataFrame:
    """Fallback: Yahoo's public chart endpoint (no crumb). Adjusted closes."""
    from urllib.parse import quote

    import requests

    start = int(pd.Timestamp(PRICE_HISTORY_START).timestamp())
    cols = {}
    for t in UNIVERSE + [BENCHMARK]:
        r = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(t)}",
            params={"period1": start, "period2": int(pd.Timestamp.now().timestamp()),
                    "interval": "1d", "events": "div,split"},
            headers={"User-Agent": "Mozilla/5.0"}, timeout=30,
        )
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]
        tz = res["meta"]["exchangeTimezoneName"]
        idx = pd.to_datetime(res["timestamp"], unit="s", utc=True).tz_convert(tz).tz_localize(None).normalize()
        adj = res["indicators"].get("adjclose") or res["indicators"]["quote"]  # short histories lack adjclose
        s = pd.Series(adj[0].get("adjclose") or adj[0]["close"], index=idx, dtype=float)
        cols[t] = s.groupby(level=0).last()  # one close per day
    return pd.DataFrame(cols)


def fetch_closes() -> pd.DataFrame:
    """Dividend-adjusted daily closes for the universe + S&P 500 TR. yfinance first, chart API fallback."""
    import yfinance as yf

    df = pd.DataFrame()
    try:
        df = yf.download(UNIVERSE + [BENCHMARK], start=PRICE_HISTORY_START, auto_adjust=True,
                         progress=False, threads=False)["Close"]
        df.index = pd.DatetimeIndex(df.index).tz_localize(None).normalize()
    except Exception as e:  # noqa: BLE001 — any yfinance failure → fallback
        print(f"yfinance failed ({e}); trying chart API")
    if df.dropna(how="all").empty or any(t not in df or df[t].isna().all() for t in UNIVERSE + [BENCHMARK]):
        print("yfinance returned no/partial data; using Yahoo chart API")
        df = _closes_from_chart_api()
    df = df.dropna(how="all")
    missing = [t for t in UNIVERSE + [BENCHMARK] if t not in df or df[t].dropna().empty]
    if df.empty or missing:
        raise SystemExit(f"mag7: no Yahoo prices for {missing or 'any ticker'} (rate-limited?) — nothing written")
    return df


def today_et() -> date:
    return datetime.now(ZoneInfo("America/New_York")).date()


def fetch_all(sb, table: str, columns: str, order: str) -> list[dict]:
    rows, offset = [], 0
    while True:
        page = sb.table(table).select(columns).order(order).range(offset, offset + 999).execute().data
        rows += page
        if len(page) < 1000:
            return rows
        offset += 1000


def write(sb, plan: Plan, stored_equity_dates: set[str]) -> None:
    for s in plan.new_signals:
        sb.table("mag7_signals").insert({
            "signal_date": str(s["signal_date"]), "selected": s["selected"], "source": s["source"],
        }).execute()
        sb.table("mag7_ranks").insert([
            {"signal_date": str(s["signal_date"]), "ticker": t,
             **{k: (None if pd.isna(v) else round(float(v), 6) if k.startswith(("ret_", "avg_")) else int(v))
                for k, v in r.items()}}
            for t, r in s["ranks"].iterrows()
        ]).execute()
    for t in plan.new_trades:
        sb.table("mag7_trades").insert({**t, "trade_date": str(t["trade_date"]),
                                        "signal_date": str(t["signal_date"])}).execute()
    for f in plan.filled:
        sb.table("mag7_signals").update({"trade_date": str(f["trade_date"]), "action": f["action"]}) \
            .eq("signal_date", str(f["signal_date"])).is_("action", "null").execute()

    sb.table("mag7_equity").delete().eq("kind", "latest").execute()
    fresh = [{**r, "date": str(r["date"])} for r in plan.equity
             if r["kind"] == "latest" or str(r["date"]) not in stored_equity_dates]
    for i in range(0, len(fresh), 500):
        sb.table("mag7_equity").upsert(fresh[i:i + 500], on_conflict="date").execute()


def summarize(plan: Plan) -> None:
    print(f"new signals: {len(plan.new_signals)}  new trades: {len(plan.new_trades)}  "
          f"filled: {len(plan.filled)}  equity rows: {len(plan.equity)}")
    if plan.new_signals:
        last = plan.new_signals[-1]
        print(f"\nlatest signal {last['signal_date']} ({last['source']}) → {last['selected']}")
        print((last["ranks"].assign(**{c: last["ranks"][c].map("{:+.1%}".format)
                                       for c in ("ret_3m", "ret_6m", "ret_12m")})).to_string())
    switches = sum(1 for f in plan.filled if f["action"] == "switch")
    print(f"\nswitches: {switches}")
    if plan.equity:
        e0, e1 = plan.equity[0], plan.equity[-1]
        print(f"equity {e0['date']} → {e1['date']}: strategy ${e1['strategy']:,.0f}  "
              f"equal-weight ${e1['equal_weight']:,.0f}  S&P 500 TR ${e1['sp500']:,.0f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="compute from scratch; write nothing")
    args = ap.parse_args()

    closes = fetch_closes()
    today = today_et()
    print(f"prices through {closes.index[-1].date()} (today ET {today})")

    if args.dry_run:
        summarize(plan_run(closes, today, [], []))
        return

    from supabase import create_client

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    stored_signals = fetch_all(sb, "mag7_signals", "signal_date,selected,action", "signal_date")
    stored_trades = fetch_all(sb, "mag7_trades", "trade_date,side,ticker,amount", "trade_date")
    stored_equity = {r["date"] for r in sb.table("mag7_equity").select("date")
                     .eq("kind", "month_end").limit(5000).execute().data}
    plan = plan_run(closes, today, stored_signals, stored_trades)
    write(sb, plan, stored_equity)
    summarize(plan)


if __name__ == "__main__":
    main()
