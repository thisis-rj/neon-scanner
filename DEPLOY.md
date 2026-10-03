# Deployment

The system has two cloud surfaces. Both are free-tier-friendly.

```
┌─────────────────────────────────────────┐
│ GitHub Actions (cron)                   │   ← ingest pipeline runs nightly
│   • etf_aum_yahoo                       │     regardless of your laptop
│   • etf_shares_ishares                  │
│   • etf_flows (Mondays)                 │
│   • etf_metrics                         │
└────────────────┬────────────────────────┘
                 │ writes
                 ▼
┌─────────────────────────────────────────┐
│ Supabase                                │   ← always-on Postgres
└────────────────┬────────────────────────┘
                 │ reads
                 ▼
┌─────────────────────────────────────────┐
│ Vercel (Next.js)                        │   ← /flows dashboard
└─────────────────────────────────────────┘
```

---

## 1. GitHub Actions cron (the ingest)

### One-time setup

1. **Add repo secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `SUPABASE_URL` — same as in your local `.env`
   - `SUPABASE_SECRET_KEY` — same as in your local `.env`
   - `EDGAR_USER_AGENT` — same as in your local `.env`

2. **Commit + push** the `.github/workflows/daily-ingest.yml` file (it should auto-detect on push).

3. **Verify** in the GitHub web UI: repo → Actions tab → "Daily ETF flow ingest" should appear with a "Run workflow" button.

4. **Trigger a manual run** to test before the first cron fires:
   - Actions tab → "Daily ETF flow ingest" → "Run workflow" → main branch → Run
   - Wait ~3 minutes; verify logs show all steps green.

### Schedule

- Daily at **22:00 UTC**, Monday–Friday (= 6 PM ET winter / 5 PM ET summer — after market close).
- N-PORT XML refresh only runs Mondays (weekly is plenty since filings dribble in).
- `dera-refresh` job is manual-only — fire it via "Run workflow" when SEC publishes a new quarter (~4x/year, around early Feb/May/Aug/Nov).

### Free tier budget

GitHub Actions on private repos = **2000 free minutes/month**.
Our usage: ~3 min/day × 22 weekdays ≈ **66 min/month**. ~3% of the budget.

---

## 2. Vercel (the dashboard)

### One-time setup

1. **Import repo on Vercel**:
   - vercel.com → New Project → Import Git Repository → pick `solveandbuild-source/neon-scanner` (renamed from portfolio-scanner; GitHub auto-redirects)
   - **Root directory**: `web` (the Next.js app lives there, not at repo root)
   - Framework preset: Next.js (auto-detected)

2. **Environment variables** (Project Settings → Environment Variables):
   - `SUPABASE_URL` — same as above
   - `SUPABASE_SECRET_KEY` — same as above (server-side reads only)
   - Apply to: Production + Preview + Development (preview builds of branches need them too, or every page errors)

3. **Production branch** (Project Settings → Environments → Production): `main`.

### How deploys work

- Push to `main` → production deploy. Push to any other branch (or open a PR) → preview deploy at its own URL, linked from the PR.
- `scripts/deploy.sh "msg"` = commit + push (plus an empty keep-alive commit when nothing changed — see §1 on the 60-day cron rule).
- Never `vercel --prod` by hand: production must always equal `main`.
- Rollback: Vercel dashboard → Deployments → previous production deploy → "Promote to Production", then revert the commit on `main` so git matches.

### What the user sees

- Every page reads directly from Supabase in a server component on each request (no client-side DB access, no build-time snapshot).
- The Filings page header shows the age of the newest filing and turns amber after 7 days, so a stalled ingest is visible without checking logs.

---

## 3. Decommissioning the local launchd setup

If you previously loaded the macOS launchd job, unload it:

```bash
launchctl unload ~/Library/LaunchAgents/com.portfolio-scanner.daily.plist
rm ~/Library/LaunchAgents/com.portfolio-scanner.daily.plist
```

The `scripts/daily_ingest.sh` and `scripts/com.portfolio-scanner.daily.plist` files remain in the repo as **local-test utilities** — useful when developing the ingest scripts on your laptop. They're not the production path anymore.

---

## 4. Health & monitoring

| Surface | Where to check |
|---|---|
| Ingest succeeded today? | GitHub repo → Actions tab → latest "Daily ETF flow ingest" run is green |
| Any source stale? | Visit `/flows` — red banner at the top fires automatically |
| Database content | Supabase dashboard → Table Editor → `etf_metrics` / `etf_aum_daily` |

If the ingest workflow fails 2 days in a row, GitHub emails you automatically (default for the repo owner).
