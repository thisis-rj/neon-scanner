"""Newsletter inbox reader (Gmail over IMAP with an app password).

  python -m ingest.newsletters --scan     # list newsletter senders of the last 14 days -> newsletter_senders

Reads HEADERS ONLY (From / Subject / Date / List-Unsubscribe); only mail with a
List-Unsubscribe header (i.e. newsletters) is recorded. Results go to the DB,
not stdout, because GitHub Actions logs on this public repo are public.
Needs GMAIL_ADDRESS + GMAIL_APP_PASSWORD.
"""
from __future__ import annotations

import argparse
import email
import email.header
import email.utils
import imaplib
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import re
import time

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _dec(v: str | None) -> str:
    if not v:
        return ""
    return "".join(p.decode(enc or "utf-8", "replace") if isinstance(p, bytes) else p
                   for p, enc in email.header.decode_header(v)).strip()


def connect() -> imaplib.IMAP4_SSL:
    m = imaplib.IMAP4_SSL("imap.gmail.com")
    m.login(os.environ["GMAIL_ADDRESS"].strip(), os.environ["GMAIL_APP_PASSWORD"].replace(" ", "").strip())
    m.select('"[Gmail]/All Mail"', readonly=True)
    return m


def scan(days: int = 14) -> None:
    m = connect()
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%d-%b-%Y")
    _, data = m.search(None, f'(SINCE "{since}")')
    ids = data[0].split()
    senders: dict[str, dict] = defaultdict(lambda: dict(name="", n=0, last=None, subjects=[]))
    for i in range(0, len(ids), 200):
        batch = b",".join(ids[i:i + 200])
        _, rows = m.fetch(batch, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE LIST-UNSUBSCRIBE)])")
        for part in rows:
            if not isinstance(part, tuple):
                continue
            msg = email.message_from_bytes(part[1])
            if not msg.get("List-Unsubscribe"):
                continue  # not a newsletter
            name, addr = email.utils.parseaddr(_dec(msg.get("From")))
            addr = addr.lower()
            if not addr:
                continue
            s = senders[addr]
            s["name"] = s["name"] or name
            s["n"] += 1
            try:
                d = email.utils.parsedate_to_datetime(msg.get("Date"))
                if d and (s["last"] is None or d > s["last"]):
                    s["last"] = d
            except Exception:
                pass
            subj = _dec(msg.get("Subject"))[:120]
            if subj and len(s["subjects"]) < 3 and subj not in s["subjects"]:
                s["subjects"].append(subj)
    m.logout()
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    now = datetime.now(timezone.utc).isoformat()
    rows = [dict(sender_email=a, sender_name=s["name"] or None, messages_14d=s["n"],
                 last_seen=s["last"].isoformat() if s["last"] else None, sample_subjects=s["subjects"], scanned_at=now)
            for a, s in senders.items()]
    for i in range(0, len(rows), 500):
        sb.table("newsletter_senders").upsert(rows[i:i + 500], on_conflict="sender_email").execute()
    print(f"scanned {len(ids)} messages; {len(rows)} newsletter senders saved", flush=True)


# Newsletters that feed the daily report's market takeaway (senders confirmed by --scan, Nov 2026).
MARKET_SENDERS = {"press@shortsqueez.co": "Short Squeez", "noreply@news.bloomberg.com": "Money Stuff"}
TAKEAWAY_PROMPT = (
    "You get today's finance newsletters (Short Squeez = Wall Street news; Money Stuff = Matt Levine's column). "
    "Write the market takeaway for a retail investor in TWO short lines, in your own words (never quote): "
    "line 1 = what moved markets / the main story; line 2 = the other notable item. Each line max 18 words. "
    "Plain English, no jargon, no emojis, no source names. Reply with the two lines separated by ' | '."
)


def _body_text(msg: email.message.Message) -> str:
    import html as _html
    parts = []
    for part in msg.walk():
        ct = part.get_content_type()
        if ct not in ("text/plain", "text/html") or part.get_filename():
            continue
        try:
            raw = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
        except Exception:
            continue
        if ct == "text/html":
            raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
            raw = _html.unescape(re.sub(r"<[^>]+>", " ", raw))
        parts.append((ct, raw))
    text = next((t for c, t in parts if c == "text/plain"), None) or next((t for _, t in parts), "")
    return re.sub(r"\s+", " ", text).strip()


def market_takeaway(since: datetime) -> str | None:
    """Two-line takeaway from the market newsletters received since `since` (None if none / not configured)."""
    if not (os.environ.get("GMAIL_ADDRESS") and os.environ.get("GMAIL_APP_PASSWORD") and os.environ.get("GROQ_API_KEY")):
        return None
    try:
        m = connect()
    except Exception as e:
        print(f"  newsletter inbox login failed: {e}", flush=True)
        return None
    texts = []
    day = (since - timedelta(days=1)).strftime("%d-%b-%Y")
    for addr, label in MARKET_SENDERS.items():
        _, data = m.search(None, f'(SINCE "{day}" FROM "{addr}")')
        for mid in data[0].split()[-3:]:
            _, rows = m.fetch(mid, "(BODY.PEEK[])")
            msg = email.message_from_bytes(rows[0][1])
            try:
                d = email.utils.parsedate_to_datetime(msg.get("Date"))
            except Exception:
                d = None
            subj = _dec(msg.get("Subject"))
            if d is None or d < since or "subscribed" in subj.lower():
                continue
            texts.append(f"[{label}] {subj}\n{_body_text(msg)[:6000]}")
    m.logout()
    if not texts:
        return None
    body = dict(model=os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"), temperature=0.2, max_tokens=800,
                reasoning_effort="low", include_reasoning=False,
                messages=[dict(role="system", content=TAKEAWAY_PROMPT), dict(role="user", content="\n\n".join(texts)[:16000])])
    for attempt in range(3):
        r = requests.post("https://api.groq.com/openai/v1/chat/completions", json=body,
                          headers={"Authorization": f"Bearer {os.environ['GROQ_API_KEY']}"}, timeout=90)
        if r.status_code == 429:
            time.sleep(float(r.headers.get("retry-after", 0)) or 10 * (attempt + 1))
            continue
        if r.status_code != 200:
            print(f"  takeaway groq {r.status_code}", flush=True)
            return None
        out = " ".join((r.json()["choices"][0]["message"].get("content") or "").split()).strip('"“”')
        return out or None
    return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--scan", action="store_true")
    p.add_argument("--days", type=int, default=14)
    a = p.parse_args()
    if a.scan:
        scan(a.days)


if __name__ == "__main__":
    main()
