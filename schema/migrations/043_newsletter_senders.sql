-- Newsletter senders seen in the newsletter Gmail inbox (headers only: sender,
-- count, a few subjects — never bodies). Written by ingest/newsletters.py --scan;
-- used to pick which newsletters feed the daily report's market summary.
-- Kept in the DB (RLS, service key only) because Actions logs are public.
create table if not exists newsletter_senders (
  sender_email     text primary key,
  sender_name      text,
  messages_14d     int not null,
  last_seen        timestamptz,
  sample_subjects  text[] not null default '{}',
  scanned_at       timestamptz not null default now()
);
alter table newsletter_senders enable row level security;
