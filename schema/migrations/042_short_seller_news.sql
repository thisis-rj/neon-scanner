-- Short-seller news: articles about short-seller reports / campaigns, from
-- Google News search per held stock plus a market-wide query. Written by
-- ingest/short_sellers.py (daily-report.yml); read by /short-sellers and the
-- daily report. ticker is NULL for market-wide items not tied to a holding.
create table if not exists short_seller_news (
  url          text primary key,
  ticker       text,
  firms        text[] not null default '{}',   -- known short-seller firms named in the headline
  title        text not null,
  source       text,
  published    date not null,
  kind         text not null check (kind in ('report', 'commentary')),
  fetched_at   timestamptz not null default now()
);
create index if not exists short_seller_news_ticker_idx on short_seller_news (ticker, published desc);
create index if not exists short_seller_news_published_idx on short_seller_news (published desc);
alter table short_seller_news enable row level security;
