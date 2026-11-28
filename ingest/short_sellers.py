"""Short-seller news for held stocks + a market-wide feed (Google News RSS, free).

  python -m ingest.short_sellers            # last 7 days
  python -m ingest.short_sellers --days 60  # backfill

Why Google News: only 2 of 18 short-seller firms publish a working RSS feed
(tested Nov 2026), but every real short attack gets press coverage naming the
company. Headlines are kept only if they name the company AND read as a
short-seller item; "report" = names a known short-seller firm or says
"short report"/"short-seller report", otherwise "commentary".
"""
from __future__ import annotations

import argparse
import email.utils
import json
import os
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

FIRMS = ["Hunterbrook", "Muddy Waters", "Hindenburg", "Kerrisdale", "Spruce Point", "Grizzly", "Fuzzy Panda",
         "Culper", "Wolfpack", "Viceroy", "Blue Orca", "Morpheus", "J Capital", "Iceberg Research", "Citron",
         "Scorpion Capital", "Bleecker Street", "Gotham City", "Snowcap", "Bonitas", "Jehoshaphat", "Glasshouse",
         "Night Market", "Ningi", "Shadowfall", "Bear Cave", "Capybara", "White Diamond", "Safkhet",
         "Carson Block", "Andrew Left", "Fraser Perring", "Edwin Dorsey", "Michael Burry", "Jim Chanos", "John Hempton"]
SHORTY = re.compile(r"short[- ]sellers?|short reports?|short-selling report|short attack|activist short|short campaign|"
                    + "|".join(map(re.escape, FIRMS)), re.I)
REPORTY = re.compile(r"short reports?|short-seller report|short seller report|short attack|"
                     + "|".join(map(re.escape, FIRMS)), re.I)
NOISE = re.compile(r"falls short|short[- ]term|short squeeze|short interest|short seller tracker|"
                   r"what would a short seller say|shortlist|short film|short story", re.I)
SUFFIX = re.compile(r"\b(Inc|Incorporated|Corp|Corporation|Company|Co|Holdings?|Group|Technologies|Platforms|Ltd|Limited|"
                    r"plc|N\.V|S\.A|AG|SE|Class [A-C]|Common Stock|ADR|Sponsored)\b\.?,?", re.I)
# Better search names where the legal name is ambiguous or unusual.
SEARCH_NAME = {"RIOT": "Riot Platforms", "HUT": "Hut 8", "ANT": "Anthropic", "TSM": "TSMC", "GOOG": "Alphabet",
               "META": "Meta Platforms", "GEV": "GE Vernova", "IREN": "IREN"}


def gnews(q: str) -> list[dict]:
    u = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    try:
        x = requests.get(u, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).text
        items = ET.fromstring(x).iter("item")
    except Exception:
        return []
    out = []
    for it in items:
        title = (it.findtext("title") or "").strip()
        src = it.findtext("source")
        if src and title.endswith(" - " + src):
            title = title[: -len(src) - 3]
        out.append(dict(url=it.findtext("link"), title=title, source=src,
                        published=str(email.utils.parsedate_to_datetime(it.findtext("pubDate")).date())))
    return out


def classify(title: str) -> tuple[str | None, list[str]]:
    if NOISE.search(title) or not SHORTY.search(title):
        return None, []
    firms = [f for f in FIRMS if f.lower() in title.lower()]
    return ("report" if REPORTY.search(title) else "commentary"), firms


def short_name(ticker: str, name: str | None) -> str:
    if ticker in SEARCH_NAME:
        return SEARCH_NAME[ticker]
    n = SUFFIX.sub("", name or ticker)
    return re.sub(r"\s+", " ", n).strip(" ,.") or ticker


TARGET_PROMPT = (
    "You read news headlines about short sellers. For EACH numbered headline decide which company the short "
    "seller is betting AGAINST (the target), using the candidate list when it matches, and the kind: "
    "'report' = a short seller published a report/attack or disclosed a short on that company; "
    "'commentary' = articles about short sellers' views, losses or past calls on that company; "
    "'none' = not about a short seller betting against a company. Mentions of other companies in passing "
    "(e.g. 'AMD falls after short report; Nvidia also down') do NOT make them the target. "
    "Reply ONLY with a JSON list of objects: {\"i\": <number>, \"target\": <ticker from the candidates or "
    "\"OTHER\" or null>, \"kind\": \"report\"|\"commentary\"|\"none\", \"firm\": <short seller name or null>}."
)


def classify_targets(items: list[dict], candidates: dict[str, str]) -> list[dict]:
    """Ask the model who each headline's short seller is targeting. Falls back to keyword rules without a key."""
    key = os.environ.get("GROQ_API_KEY")
    if not key or not items:
        return [dict(i=n, target=it.get("ticker"), kind=it.get("kind"), firm=(it.get("firms") or [None])[0]) for n, it in enumerate(items)]
    cand = "; ".join(f"{t} = {n}" for t, n in candidates.items())
    out: list[dict] = []
    for start in range(0, len(items), 40):
        chunk = items[start:start + 40]
        lines = "\n".join(f"{start + k}. {it['title']}" for k, it in enumerate(chunk))
        body = dict(model=os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"), temperature=0, max_tokens=4000,
                    reasoning_effort="low", include_reasoning=False,
                    messages=[dict(role="system", content=TARGET_PROMPT),
                              dict(role="user", content=f"Candidates: {cand}\n\nHeadlines:\n{lines}")])
        for attempt in range(3):
            r = requests.post("https://api.groq.com/openai/v1/chat/completions", json=body,
                              headers={"Authorization": f"Bearer {key}"}, timeout=90)
            if r.status_code == 429:
                time.sleep(float(r.headers.get("retry-after", 0)) or 10 * (attempt + 1))
                continue
            break
        try:
            txt = r.json()["choices"][0]["message"]["content"]
            out += json.loads(txt[txt.index("["): txt.rindex("]") + 1])
        except Exception as e:
            print(f"  target classification failed for a batch: {e}", flush=True)
        time.sleep(2)
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    a = p.parse_args()
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    held = sorted({r["ticker"] for r in sb.table("portfolio_positions").select("ticker").gt("qty", 0).execute().data or []})
    names = {r["ticker"]: r.get("name") for r in sb.table("tickers").select("ticker,name").in_("ticker", held).execute().data or []}
    cands = {t: short_name(t, names.get(t)) for t in held}
    found: dict[str, dict] = {}
    for t in held:
        n = cands[t]
        q = f'"{n}" ("short seller" OR "short-seller" OR "short report" OR "short attack") when:{a.days}d'
        for it in gnews(q):
            kind, firms = classify(it["title"])
            if kind and it["url"]:
                found.setdefault(it["url"], dict(it, ticker=t, firms=firms, kind=kind))
        time.sleep(1.0)
    for it in gnews(f'("short seller" OR "short-seller" OR "short report") (report OR alleges OR targets) when:{a.days}d'):
        kind, firms = classify(it["title"])
        if kind == "report" and it["url"]:
            found.setdefault(it["url"], dict(it, ticker=None, firms=firms, kind=kind))
    # Who is the short seller actually betting against? (keyword match alone tags AMD stories to Nvidia)
    items = list(found.values())
    verdicts = {v.get("i"): v for v in classify_targets(items, cands) if isinstance(v, dict)}
    rows: dict[str, dict] = {}
    for n, it in enumerate(items):
        v = verdicts.get(n)
        if not v or v.get("kind") not in ("report", "commentary"):
            continue
        tgt = v.get("target") if v.get("target") in held else None
        if it["ticker"] is None and v.get("kind") != "report":
            continue  # market-wide feed keeps reports only
        firms = sorted(set(it["firms"]) | ({v["firm"]} if v.get("firm") else set()))
        rows[it["url"]] = dict(url=it["url"], title=it["title"], source=it["source"], published=it["published"],
                               ticker=tgt, firms=firms, kind=v["kind"])
    data = [r for r in rows.values() if r["url"]]
    # Insert only URLs we haven't stored, so fetched_at stays the first-seen time
    # (the daily report uses it to show only fresh items).
    for i in range(0, len(data), 500):
        sb.table("short_seller_news").upsert(data[i:i + 500], on_conflict="url", ignore_duplicates=True).execute()
    mine = [r for r in data if r["ticker"]]
    print(f"short-seller news: {len(mine)} on held stocks ({len({r['ticker'] for r in mine})} stocks), "
          f"{len(data) - len(mine)} market-wide", flush=True)


if __name__ == "__main__":
    main()
