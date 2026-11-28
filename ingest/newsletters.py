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


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--scan", action="store_true")
    p.add_argument("--days", type=int, default=14)
    a = p.parse_args()
    if a.scan:
        scan(a.days)


if __name__ == "__main__":
    main()
