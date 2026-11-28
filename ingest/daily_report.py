"""Daily report per person: market, company filings, non-routine insider
trades, analyst rating changes, upcoming earnings. Saved to daily_reports,
shown at /report/<date>-<person>, sent as the WhatsApp template
`neon_daily_report_v2` (6 summary lines + "Open full report" button).

  python -m ingest.daily_report                       # build for everyone, don't send
  python -m ingest.daily_report --send                # build + WhatsApp (needs WHATSAPP_TOKEN, WHATSAPP_TO_<PERSON>)
  python -m ingest.daily_report --person Riya --print # build one, print it

"New" = since the previous weekday's 13:00 UTC run (Monday looks back to Friday).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SITE = "https://neon-scanner-riya1910jain-2522s-projects.vercel.app"
GRAPH = "https://graph.facebook.com/v21.0"
PHONE_NUMBER_ID = "1047051355158686"   # +91 95890 61463 (not secret)
WABA_ID = "956091127378728"
TEMPLATE = "neon_daily_report_v2"   # 6 lines: news, market, insider, shorts, ratings, earnings
IST = timezone(timedelta(hours=5, minutes=30))
MAX_PARAM = 230  # keep each WhatsApp line short; full detail is on the page

MARKET = [("S&P 500", "SPY"), ("Nasdaq-100", "QQQ"), ("Chips", "SMH"), ("Bitcoin", "BTC-USD"),
          ("Gold", "GC=F"), ("10y yield", "^TNX"), ("VIX", "^VIX")]

# 8-K item codes -> plain words (SEC Form 8-K General Instructions).
ITEMS = {
    "1.01": "signed a major agreement", "1.02": "ended a major agreement", "1.03": "bankruptcy",
    "2.01": "completed an acquisition or sale", "2.02": "reported results", "2.03": "took on new debt",
    "2.04": "debt acceleration", "2.05": "restructuring / layoffs", "2.06": "impairment (write-down)",
    "3.01": "delisting notice", "3.02": "sold unregistered shares", "3.03": "changed shareholder rights",
    "4.01": "changed auditor", "4.02": "past results no longer reliable", "5.01": "change in control",
    "5.02": "executive or director change", "5.03": "changed bylaws", "5.07": "shareholder vote results",
    "7.01": "investor presentation / FD disclosure", "8.01": "other material event",
}
DILUTION_FORMS = {"424B5", "424B3", "S-3", "S-3ASR", "F-3", "F-3ASR"}
DEAL_FORMS = {"SC TO-T", "SC TO-C", "SC 14D9", "DEFM14A", "PREM14A", "425"}
WATCH_FORMS = {"8-K", "6-K", "SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A"} | DILUTION_FORMS | DEAL_FORMS
HIGH_ITEMS = {"1.01", "1.03", "2.01", "2.03", "2.05", "2.06", "3.01", "3.02", "4.01", "4.02", "5.01", "5.02"}
# One short label per 8-K, most important item first (for the WhatsApp line).
LABEL_ORDER = [("5.01", "change in control"), ("1.03", "bankruptcy"), ("2.01", "completed a deal"),
               ("1.01", "major agreement"), ("4.02", "restated results"), ("4.01", "auditor change"),
               ("5.02", "leadership change"), ("3.01", "delisting notice"), ("2.05", "layoffs/restructuring"),
               ("2.06", "write-down"), ("2.03", "new debt"), ("3.02", "share sale"), ("2.02", "results")]


def sb_client():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])


def window_start(now: datetime) -> datetime:
    """Previous weekday's 13:00 UTC (the previous run)."""
    d = now.astimezone(timezone.utc).replace(hour=13, minute=0, second=0, microsecond=0)
    d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def pct(a: float, b: float) -> str:
    v = (a / b - 1) * 100
    return f"{'+' if v >= 0 else ''}{v:.1f}%"


def market_section() -> dict:
    """Last two completed US sessions (SPY's calendar) for every line, so a
    holiday or a half-day can't compare different days across symbols."""
    import yfinance as yf

    syms = [s for _, s in MARKET]
    d = yf.download(syms, period="15d", progress=False, auto_adjust=True)["Close"]
    today_utc = datetime.now(timezone.utc).date()
    sessions = [ts for ts in d["SPY"].dropna().index if ts.date() < today_utc]
    if len(sessions) < 2:
        return dict(asof=None, rows=[], line="Market data unavailable")
    prev_ts, last_ts = sessions[-2], sessions[-1]
    d = d.ffill()
    rows, parts = [], []
    for label, s in MARKET:
        last, prev = d.at[last_ts, s], d.at[prev_ts, s]
        if last != last or prev != prev:  # NaN
            continue
        last, prev = float(last), float(prev)
        if s == "^TNX":
            txt = f"{last:.2f}% ({last - prev:+.2f})"
        elif s == "^VIX":
            txt = f"{last:.1f} ({last - prev:+.1f})"
        else:
            txt = pct(last, prev)
        rows.append(dict(label=label, symbol=s, last=round(last, 2), change=txt))
        parts.append(f"{label} {txt}")
    asof = str(last_ts.date())
    return dict(asof=asof, rows=rows, line=f"{datetime.fromisoformat(asof).strftime('%a %d %b')}: " + ", ".join(parts))


_cik_map: dict[str, str] | None = None


def cik_for(t: str) -> str | None:
    global _cik_map
    if _cik_map is None:
        h = {"User-Agent": os.environ["EDGAR_USER_AGENT"]}
        m = requests.get("https://www.sec.gov/files/company_tickers.json", headers=h, timeout=30).json()
        _cik_map = {v["ticker"].upper(): str(v["cik_str"]).zfill(10) for v in m.values()}
    return _cik_map.get(t.upper().replace(".", "-"))


def filings_section(tickers: list[str], since: datetime) -> list[dict]:
    """New SEC filings by the companies themselves (8-K items in plain words, share sales, takeovers)."""
    h = {"User-Agent": os.environ["EDGAR_USER_AGENT"]}
    since_d = since.date().isoformat()
    out = []
    for t in tickers:
        cik = cik_for(t)
        if not cik:
            continue
        try:
            r = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=h, timeout=30).json()["filings"]["recent"]
        except Exception:
            continue
        time.sleep(0.15)
        for i, (form, fd) in enumerate(zip(r["form"], r["filingDate"])):
            if fd < since_d:
                break
            if form not in WATCH_FORMS:
                continue
            acc = r["accessionNumber"][i]
            items = [x.strip() for x in (r.get("items", [""] * (i + 1))[i] or "").split(",") if x.strip()]
            words = [ITEMS[x] for x in items if x in ITEMS and x not in ("9.01",)]
            if form in DILUTION_FORMS:
                what, level = "filed to sell new shares or notes (dilution)", "high"
            elif form in DEAL_FORMS:
                what, level = "takeover / merger filing", "high"
            elif form.startswith("SC 13D") or form.startswith("SCHEDULE 13D"):
                what, level = "an investor reported a 5%+ stake with intent to influence", "high"
            else:
                what = ", ".join(words) or "filed a 6-K / 8-K"
                level = "high" if set(items) & HIGH_ITEMS else "normal"
            doc = r["primaryDocument"][i]
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/{doc}"
            label = next((w for code, w in LABEL_ORDER if code in items), None) or (
                "share sale (dilution)" if form in DILUTION_FORMS else "takeover filing" if form in DEAL_FORMS
                else "5%+ activist stake" if "13D" in form else form)
            out.append(dict(ticker=t, form=form, filed=fd, items=items, what=what, label=label, level=level, url=url, summary=None))
    # One-sentence plain summaries for the important ones (Groq, already used by summarize_8k).
    if os.environ.get("GROQ_API_KEY"):
        try:
            from ingest.summarize_8k import fetch_filing_body, groq_summarize
            for f in [x for x in out if x["level"] == "high"][:8]:
                body = fetch_filing_body(f["url"], "", "")
                if body:
                    f["summary"] = groq_summarize(body, f["ticker"], ",".join(f["items"]) or f["form"])
        except Exception as e:  # summaries are a nice-to-have; never block the report
            print(f"  summaries skipped: {e}", flush=True)
    return sorted(out, key=lambda x: (x["level"] != "high", x["ticker"]))


def role(r: dict, title_key: str, dir_key: str) -> str:
    if r.get(title_key):
        return str(r[title_key])
    if r.get(dir_key):
        return "Director"
    return "Insider"


def insider_section(sb, tickers: list[str], since: datetime) -> list[dict]:
    """Non-routine only: unplanned sales (10b5-1 box unticked) and own-money buys, newly ingested."""
    s_iso = since.isoformat()
    # Form 4 is due within 2 business days; a re-parse can refresh created_at on old trades, so also bound the trade date.
    tx_floor = (since.date() - timedelta(days=7)).isoformat()
    sells = sb.table("events_form4").select(
        "ticker,reporter_name,officer_title,is_director,transaction_date,shares,price,is_10b5_1,created_at"
    ).in_("ticker", tickers).eq("transaction_code", "S").eq("is_10b5_1", False).gte("created_at", s_iso).gte(
        "transaction_date", tx_floor).execute().data or []
    buys = sb.table("insider_transactions").select(
        "issuer_ticker,reporter_name,officer_title,reporter_is_director,transaction_date,value_usd,is_10b5_1,fetched_at"
    ).in_("issuer_ticker", tickers).eq("transaction_code", "P").gte("fetched_at", s_iso).gte(
        "transaction_date", tx_floor).execute().data or []
    agg: dict[tuple, dict] = {}
    for r in sells:
        k = ("sell", r["ticker"], r["reporter_name"], r["transaction_date"])
        a = agg.setdefault(k, dict(side="sell", ticker=r["ticker"], name=r["reporter_name"],
                                   role=role(r, "officer_title", "is_director"), date=r["transaction_date"], usd=0.0))
        a["usd"] += float(r["shares"] or 0) * float(r["price"] or 0)
    for r in buys:
        if r.get("is_10b5_1"):
            continue
        k = ("buy", r["issuer_ticker"], r["reporter_name"], r["transaction_date"])
        a = agg.setdefault(k, dict(side="buy", ticker=r["issuer_ticker"], name=r["reporter_name"],
                                   role=role(r, "officer_title", "reporter_is_director"), date=r["transaction_date"], usd=0.0))
        a["usd"] += float(r["value_usd"] or 0)
    return sorted(agg.values(), key=lambda x: -x["usd"])


def ratings_section(sb, tickers: list[str], since: datetime) -> list[dict]:
    rows = sb.table("analyst_calls").select(
        "ticker,firm,graded_at,action,to_grade,from_grade,pt_action,price_target,prior_target"
    ).in_("ticker", tickers).gte("graded_at", since.isoformat()).order("graded_at", desc=True).execute().data or []
    out = []
    for r in rows:
        a = r["action"]
        pt, prior = r.get("price_target"), r.get("prior_target")
        tgt = ""
        if pt and prior and abs(pt - prior) > 0.005:
            tgt = f"target ${prior:,.0f} → ${pt:,.0f}"
        elif pt:
            tgt = f"target ${pt:,.0f}"
        if a in ("up", "down", "init") or (pt and prior and abs(pt - prior) > 0.005):
            kind = {"up": "upgrade", "down": "downgrade", "init": "new coverage"}.get(a, "target change")
            out.append(dict(ticker=r["ticker"], firm=r["firm"], kind=kind,
                            grade=f"{r.get('from_grade') or '—'} → {r.get('to_grade') or '—'}" if a in ("up", "down") else (r.get("to_grade") or ""),
                            target=tgt, at=r["graded_at"][:10]))
    return out


def earnings_section(sb, tickers: list[str], today: date) -> list[dict]:
    rows = sb.table("earnings_calendar").select("ticker,name,next_earnings").in_("ticker", tickers).gte(
        "next_earnings", today.isoformat()).lte("next_earnings", (today + timedelta(days=14)).isoformat()).execute().data or []
    return sorted([dict(ticker=r["ticker"], name=r.get("name"), date=r["next_earnings"]) for r in rows], key=lambda x: x["date"])


def clip(items: list[str], empty: str) -> str:
    if not items:
        return empty
    s, n = "", 0
    for it in items:
        nxt = (s + "; " if s else "") + it
        if len(nxt) > MAX_PARAM - 12:
            break
        s, n = nxt, n + 1
    rest = len(items) - n
    return s + (f"; +{rest} more" if rest else "")


def summarize(content: dict) -> dict:
    fil = content["filings"]
    ins = content["insider"]
    rat = content["ratings"]
    ern = content["earnings"]
    by_t: dict[str, list[dict]] = {}
    for r in rat:
        by_t.setdefault(r["ticker"], []).append(r)
    rat_txt = []
    for t, rs in by_t.items():
        kinds = {}
        for r in rs:
            kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
        rat_txt.append(f"{t} " + ", ".join(f"{n} {k}{'s' if n > 1 and not k.endswith('coverage') else ''}" for k, n in kinds.items()))
    news = []
    for f in [x for x in fil if x["level"] == "high"]:
        news.append(f"{f['ticker']}: {f['summary'].rstrip('.')}" if f.get("summary") else f"{f['ticker']} {f['label']}")
    return dict(
        news=clip(news, "No major filings on your stocks"),
        market=content["market"]["line"][:MAX_PARAM],
        insider=clip([f"{x['ticker']} {x['role']} {'bought' if x['side'] == 'buy' else 'sold'} ${x['usd'] / 1e6:,.1f}M" for x in ins],
                     "None on your stocks"),
        shorts="Not connected yet",
        ratings=clip(rat_txt, "No changes on your stocks"),
        earnings=clip([f"{e['ticker']} {datetime.fromisoformat(e['date']).strftime('%a %d %b')}" for e in ern], "None in the next 2 weeks"),
    )


def clean_param(s: str) -> str:
    # WhatsApp template params: no newlines/tabs, no more than 4 consecutive spaces.
    return re.sub(r"\s+", " ", s).strip() or "-"


def send(person: str, report_id: str, summary: dict) -> bool:
    token = os.environ.get("WHATSAPP_TOKEN")
    to = os.environ.get(f"WHATSAPP_TO_{person.upper()}")
    if not token or not to:
        print(f"  {person}: no WhatsApp token/number set — built, not sent", flush=True)
        return False
    st = requests.get(f"{GRAPH}/{WABA_ID}/message_templates", params={"name": TEMPLATE, "fields": "status"},
                      headers={"Authorization": f"Bearer {token}"}, timeout=30).json()
    status = (st.get("data") or [{}])[0].get("status")
    if status != "APPROVED":
        print(f"  template {TEMPLATE} is {status} — built, not sent", flush=True)
        return False
    body = dict(messaging_product="whatsapp", to=to, type="template", template=dict(
        name=TEMPLATE, language=dict(code="en"), components=[
            dict(type="body", parameters=[dict(type="text", text=clean_param(summary[k]))
                                          for k in ("news", "market", "insider", "shorts", "ratings", "earnings")]),
            dict(type="button", sub_type="url", index="0", parameters=[dict(type="text", text=report_id)]),
        ]))
    r = requests.post(f"{GRAPH}/{PHONE_NUMBER_ID}/messages", json=body,
                      headers={"Authorization": f"Bearer {token}"}, timeout=30).json()
    ok = "messages" in r
    print(f"  {person}: {'sent' if ok else 'send failed: ' + str(r.get('error', {}).get('message'))}", flush=True)
    return ok


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--person", default=None)
    p.add_argument("--send", action="store_true")
    p.add_argument("--print", action="store_true")
    p.add_argument("--since", default=None, help="override the window start, e.g. 2026-11-23T13:00:00+00:00 (testing)")
    a = p.parse_args()
    sb = sb_client()
    now = datetime.now(timezone.utc)
    today = now.astimezone(IST).date()
    since = datetime.fromisoformat(a.since) if a.since else window_start(now)
    pos = sb.table("portfolio_positions").select("person,ticker").gt("qty", 0).execute().data or []
    people = sorted({r["person"] for r in pos if not a.person or r["person"] == a.person})
    market = market_section()
    for person in people:
        tickers = sorted({r["ticker"] for r in pos if r["person"] == person})
        content = dict(person=person, date=today.isoformat(), window_start=since.isoformat(), tickers=tickers,
                       market=market, filings=filings_section(tickers, since), insider=insider_section(sb, tickers, since),
                       ratings=ratings_section(sb, tickers, since), earnings=earnings_section(sb, tickers, today),
                       shorts=None)
        summary = summarize(content)
        sb.table("daily_reports").upsert(dict(person=person, report_date=today.isoformat(), window_start=since.isoformat(),
                                              built_at=now.isoformat(), summary=summary, content=content),
                                         on_conflict="person,report_date").execute()
        rid = f"{today.isoformat()}-{person.lower()}"
        print(f"{person}: built {rid} ({len(content['filings'])} filings, {len(content['insider'])} insider, "
              f"{len(content['ratings'])} ratings, {len(content['earnings'])} earnings)", flush=True)
        if a.print:
            print(json.dumps(summary, indent=2))
        if a.send and send(person, rid, summary):
            sb.table("daily_reports").update(dict(sent_at=datetime.now(timezone.utc).isoformat())).eq(
                "person", person).eq("report_date", today.isoformat()).execute()


if __name__ == "__main__":
    main()
