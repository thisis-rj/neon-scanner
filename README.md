# Neon Scanner

> _(repo and local directory retain the old name `portfolio-scanner` to avoid breaking the Python venv — the product is **Neon Scanner**.)_

Personal signal-extraction system that watches a curated universe of SEC filers (activists, value managers, notable insiders) and surfaces entry signals when filings cluster on a ticker — while filtering out anything that has already run too far to enter without FOMO.

## What it does

- Polls SEC EDGAR for filings from a tracked filer list (13F-HR, 13D/G, Form 4).
- Scores ticker-level confluence across filers within a rolling window.
- Filters the investable universe to exclude late-stage runners (trailing 6mo > 60% by default).
- Monitors held positions against non-negotiable exit rules.
- Surfaces signals in a minimal Next.js UI. No "trending", no narrative, no fabricated metrics.

## What it deliberately does NOT do

See [CLAUDE.md §2 and §8](CLAUDE.md). Short version: no FOMO surfaces, no LLM rationale, no alt-data, no synthetic conviction scores.

## Stack

- Ingestion: Python 3.11+
- Database: Supabase (Postgres + RLS)
- Frontend: Next.js on Vercel
- Scheduling: GitHub Actions cron

## Status

Live. The daily ingest runs on GitHub Actions and the UI is deployed on Vercel. **Read `CLAUDE.md` first** — the design philosophy there is load-bearing (no FOMO surfaces, no fabricated metrics; see §2).

## Getting started (new contributor)

1. **Clone**
   ```bash
   git clone https://github.com/solveandbuild-source/neon-scanner.git
   ```
2. **Secrets** — get the real values from Riya (share them securely, not over chat). Copy the templates and fill them in. Both target files are gitignored — never commit them:
   ```bash
   cp .env.example .env                       # Python ingest: Supabase + EDGAR + Groq (+ PAT for migrations)
   cp web/.env.local.example web/.env.local   # web app: Supabase URL + secret key
   ```
3. **Web app**
   ```bash
   cd web && npm install && npm run dev       # http://localhost:3000
   ```
4. **Python ingest**
   ```bash
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   python -m ingest.edgar                     # example: poll EDGAR for new filings
   ```
5. **Deploying** — always `scripts/deploy.sh "message"`, never a bare `vercel --prod`. It ships to Vercel *and* commits+pushes; GitHub disables the ingest cron after 60 days with no commits (see `CLAUDE.md` §10).

## Where things live

| Path | What |
|---|---|
| `ingest/` | Python ETL — EDGAR poll, 13F/13D/Form-4 parsers, prices, earnings, cost basis |
| `web/app/` | Next.js routes (one folder per page; a `page.tsx.disabled` is a hidden route) |
| `web/components/`, `web/lib/` | shared UI + helpers |
| `schema/migrations/` | numbered SQL, auto-applied by `ingest/migrate.py` |
| `config/tracked_filers.yml` | the watched filer universe |
| `.github/workflows/daily-ingest.yml` | the scheduled pipeline |
| `CLAUDE.md` | architecture + non-negotiable design rules — read before coding |
