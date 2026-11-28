"""Generate one-sentence summaries for 8-K filings via Groq (Llama 3.3 70B).

8-K item codes (1.01, 2.01, 5.02, 8.01) tell you the *category* of news but
not the actual content. Reading the filing body gives you the headline; this
script uses an LLM to extract that headline automatically.

Free tier: 30 req/min, 1000 req/day on llama-3.3-70b-versatile. We have ~449
8-Ks ingested, so the one-time backfill takes ~15-20 minutes at 30 req/min.

Usage:
  python -m ingest.summarize_8k              # summarize all unsummarized 8-Ks
  python -m ingest.summarize_8k --limit 5    # smoke test on 5
  python -m ingest.summarize_8k --resummarize  # re-do everything (e.g., after prompt change)

Idempotent: skips filings that already have a summary unless --resummarize.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

GROQ_API_KEY = os.environ["GROQ_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
EDGAR_USER_AGENT = os.environ["EDGAR_USER_AGENT"]

# Groq retired llama-3.3-70b-versatile (404 model_not_found, seen Nov 2026) — Vijay: override with GROQ_MODEL if needed.
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Polite scrape pace for sec.gov.
MIN_INTERVAL_S = 1.0 / 8
_last_request_at = 0.0

# Groq free tier has both RPM (30) and TPM (12,000) limits for llama-3.3-70b.
# Each request is ~1000-1500 tokens, so TPM is the binding constraint.
# 12,000 / 1200 avg tokens = 10 req/min = 6s spacing for safe steady-state.
GROQ_MIN_INTERVAL_S = 6.1
_last_groq_at = 0.0

# Smaller input = fewer tokens per request = more requests fit in the budget.
MAX_INPUT_CHARS = 2500

SYSTEM_PROMPT = """You are a financial news summarizer. You will be given an 8-K filing or attached press release.

Your job: output exactly ONE short sentence (max 20 words) describing what specifically happened. Be concrete and factual:

GOOD examples:
- "NVIDIA agreed to invest $5B in Intel via convertible preferred stock."
- "Oracle named Larry Ellison's son David as new CTO, effective immediately."
- "Adobe authorized a $25B share repurchase program through 2028."

BAD examples (do not write these):
- "Material event disclosed."  (too vague)
- "The company announced something."  (no content)
- "This 8-K describes a press release about..."  (meta-commentary)

If the filing is genuinely routine/ambiguous, output one short sentence about what little IS in the filing — never speculate, never add color commentary. Output ONLY the sentence, no preamble.
"""


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def _polite_get(url: str) -> requests.Response | None:
    """GET sec.gov with rate-limit + 5xx retry. Returns None on hard failure."""
    global _last_request_at
    for attempt in range(3):
        delta = time.monotonic() - _last_request_at
        if delta < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - delta)
        try:
            r = requests.get(
                url,
                headers={"User-Agent": EDGAR_USER_AGENT, "Accept": "text/html,*/*"},
                timeout=30,
            )
            _last_request_at = time.monotonic()
            if 500 <= r.status_code < 600:
                time.sleep(1.5 * (attempt + 1))
                continue
            return r
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(1.5 * (attempt + 1))
    return None


def fetch_filing_body(primary_doc_url: str | None, cik: str, accession: str) -> str | None:
    """Get the 8-K body. Tries primary_doc_url; falls back to filing's index.

    Returns plain text (HTML stripped, whitespace collapsed)."""
    if primary_doc_url:
        r = _polite_get(primary_doc_url)
        if r and r.status_code == 200 and r.text:
            return _to_text(r.text)

    # Fallback: index.json → first .htm/.html
    acc_nodash = accession.replace("-", "")
    cik_int = int(cik)
    idx = _polite_get(f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/index.json")
    if not idx or idx.status_code != 200:
        return None
    try:
        files = idx.json().get("directory", {}).get("item", [])
    except Exception:
        return None
    for f in files:
        nm = f.get("name", "").lower()
        if nm.endswith(".htm") or nm.endswith(".html"):
            r = _polite_get(f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{f['name']}")
            if r and r.status_code == 200:
                return _to_text(r.text)
    return None


_RX_TAG = re.compile(r"<[^>]+>")
_RX_WS = re.compile(r"\s+")


def _to_text(html: str) -> str:
    """Naive HTML → text. Sufficient for press-release content extraction."""
    text = _RX_TAG.sub(" ", html)
    text = _RX_WS.sub(" ", text).strip()
    # Limit to MAX_INPUT_CHARS to fit Groq's token-per-minute budget.
    # The actual news is usually in the first 1-2K chars of an 8-K cover.
    return text[:MAX_INPUT_CHARS]


def groq_summarize(body: str, filer_name: str | None, items: str | None) -> str | None:
    """Send the filing body to Groq, return a one-sentence summary or None.

    Handles 429 (TPM/RPM rate limit) by sleeping for retry-after and looping.
    Up to 3 attempts on 429 before giving up on this filing.
    """
    global _last_groq_at
    user_msg = (
        f"Filer: {filer_name or 'unknown'}\n"
        f"8-K items reported: {items or 'unknown'}\n\n"
        f"Filing text:\n{body}"
    )
    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.2,
        "max_tokens": 80,
    }
    if GROQ_MODEL.startswith("openai/gpt-oss"):
        # Reasoning model: its thinking counts against max_tokens, so keep thinking
        # short, hide it from the reply, and leave room for the one-sentence answer.
        payload.update({"max_tokens": 600, "reasoning_effort": "low", "include_reasoning": False})

    for attempt in range(3):
        # Steady-state pacing (TPM-aware)
        delta = time.monotonic() - _last_groq_at
        if delta < GROQ_MIN_INTERVAL_S:
            time.sleep(GROQ_MIN_INTERVAL_S - delta)
        try:
            r = requests.post(
                GROQ_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json=payload,
                timeout=30,
            )
            _last_groq_at = time.monotonic()
        except Exception as e:
            print(f"  groq exception: {e}", file=sys.stderr)
            return None

        if r.status_code == 429:
            # Respect retry-after if present, otherwise back off based on attempt.
            wait = float(r.headers.get("retry-after", 0)) or (5 + 10 * attempt)
            print(f"  rate-limited; sleeping {wait:.1f}s then retrying", flush=True)
            time.sleep(wait)
            continue

        if r.status_code != 200:
            print(f"  groq error {r.status_code}: {r.text[:200]}", file=sys.stderr)
            return None

        try:
            data = r.json()
            text = data["choices"][0]["message"]["content"].strip()
            text = text.strip('"“”').strip()
            text = " ".join(text.split())
            return text or None
        except Exception as e:
            print(f"  groq parse error: {e}", file=sys.stderr)
            return None

    return None


def get_pending(sb: Client, resummarize: bool) -> list[dict[str, Any]]:
    """Pull 8-K filings that need summarizing."""
    q = (
        sb.table("filings_raw")
        .select("id,accession_number,cik,filer_name,filed_at,primary_doc_url,raw_payload")
        .in_("form_type", ["8-K", "8-K/A"])
        .order("filed_at", desc=True)
    )
    if not resummarize:
        q = q.is_("summary", None)
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        b = q.range(offset, offset + 999).execute()
        if not b.data:
            break
        out.extend(b.data)
        if len(b.data) < 1000:
            break
        offset += 1000
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--resummarize", action="store_true")
    args = p.parse_args()

    sb = _supabase()
    pending = get_pending(sb, args.resummarize)
    if args.limit:
        pending = pending[: args.limit]
    print(f"To summarize: {len(pending)} 8-K filings.\n", flush=True)

    ok = 0
    fail = 0
    t0 = time.monotonic()

    for i, f in enumerate(pending, 1):
        items = (f.get("raw_payload") or {}).get("items") or ""
        body = fetch_filing_body(f.get("primary_doc_url"), f["cik"], f["accession_number"])
        if not body:
            fail += 1
            print(f"[{i}/{len(pending)}] {f['filer_name']}  — no body", flush=True)
            continue
        summary = groq_summarize(body, f.get("filer_name"), items)
        if not summary:
            fail += 1
            print(f"[{i}/{len(pending)}] {f['filer_name']}  — groq failed", flush=True)
            continue
        # store
        sb.table("filings_raw").update({"summary": summary}).eq("id", f["id"]).execute()
        ok += 1
        if i <= 10 or i % 25 == 0 or i == len(pending):
            elapsed = time.monotonic() - t0
            print(f"[{i}/{len(pending)}] {f['filer_name'][:30]:30}  ({elapsed:.0f}s)", flush=True)
            print(f"    {summary}", flush=True)

    print(f"\n=== Summary ===", flush=True)
    print(f"Summarized : {ok}/{len(pending)}", flush=True)
    print(f"Failed     : {fail}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted; partial progress committed.", file=sys.stderr)
        sys.exit(130)
