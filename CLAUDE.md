# CLAUDE.md — Neon Scanner

> _(repo dir is still `portfolio-scanner` to avoid breaking the venv. Product name: **Neon Scanner**.)_

> Read this in full before writing any code. The philosophy here is load-bearing. The wrong instinct (build-more, add-LLM-layer, surface-trending-tickers) will silently corrupt the system. When in doubt, do less.

---

## 1. Who is the user

- Solo operator building this for personal use.
- Investor-operator: makes capital allocation decisions from the output of this system.
- Direct communicator. Pushback is welcomed. Do not soften disagreement with hedges. If a request conflicts with the philosophy in §2, say so before implementing.
- Has explicitly rejected: narrative-driven UI, "trending" feeds, fabricated composite metrics, anything that imports FOMO into the decision loop.

---

## 2. Design philosophy (non-negotiable)

These are not preferences. They are the reason the system exists. Every feature must pass these tests.

### 2.1 Signal-driven, not narrative-driven
The system surfaces **observable filings and price-action signals** from a fixed universe of tracked filers and a filtered ticker universe. It does **not** generate stories, themes, sector calls, or "why this matters" commentary. If a signal fires, the user reads the underlying filing themselves and decides.

> User's stance (quoted): the job of the tool is to tell me what *happened*, not what it *means*. Meaning is my job.

### 2.2 FOMO-resistant by construction
This is the most important property. The system actively suppresses late-stage entry:
- Tickers whose trailing 6-month return exceeds `+60%` are **filtered out of the universe** (configurable; see `config/signal_weights.yml`). They are classified `late_stage` and excluded from new-position signals.
- No "trending", "momentum leaders", "what's hot" surface anywhere. Ever.
- Existing positions get exit-rule monitoring; that is the only place rising prices generate signals, and the signal is *evaluate exit*, not *add*.

**Note — personal strategy trackers (added 2026-10-03 at Vijay's request).** A user's own written, rules-based strategy may be tracked on its own clearly-labelled tab. Today that is exactly one: **Lag7** (`/lag7`; `ingest/mag7.py`, migration 030), which ranks the Mag7 plus SpaceX by 3/6/12-month return each month-end and buys the *worst* average rank. Buying the laggard is the opposite of FOMO, so it fits this section's intent; it is still a ranked-by-return table, allowed only because it is a fixed universe the user chose (Mag7 + SpaceX) — it surfaces no new tickers, feeds no other page or signal, and executes nothing. This note is also the exception for its equity chart (§7.7 "no charts of your own portfolio's performance") and its history backfill (§8 "backtesting framework"). The backfill starts 2025-01-01 — after the Mag7 were named in 2023 — and must never be extended earlier: before 2023 the list itself is hindsight (every past laggard among them recovered). The page must say the 2025–26 months are a backtest. A "trending" / momentum-leaders surface still violates this section.

**Note — earnings test (added 2026-10-06 at Vijay's request).** `/earnings-test` (`ingest/earnings_test.py`, migration 033) tests one hypothesis of Vijay's: a stock's 10-trading-day move before an earnings report (minus SPY) predicts its reaction-session move and its 20-day drift after. It is a research page, not a signal: it feeds no other page, signal or score, and recommends nothing. It is the second exception to §8 "backtesting framework" (5 years of history, from 2021-10, for the 300 largest stocks on the Earnings tab; the live log covers every stock on that tab). The **Fixed test** tab keeps the one rule with windows fixed before any result was seen; don't change those windows. The **Explorer** tab (Vijay's choice, 2026-10-06, made knowing that trying many windows finds one that "works" by chance) recomputes any before/after window, group count and filter from each report's stored daily returns (day −30 to +30). It must always show the earlier-half vs later-half split next to the all-seasons result, and a rule found there only counts once it holds in the live log. Context cohorts (migration 034: volume vs normal, 50/200-day averages, insider buys filed in the 90 days before, EPS vs estimate) use only information public before the report, except EPS, which the page must label as known only after it. The **Scan** tab (`ingest/earnings_scan.py`) is the only place many cuts are searched at once; it must keep the search-half / check-half split and the false-discovery correction, and show cuts that did not hold next to ones that did. Every list on the page is sorted by date or group number, never by return (§2.2). The page must say the history is a backtest built on today's stock list (survivorship), and the live log is the clean test: a live row counts only if it was logged before its reaction session opened.

### 2.3 Exit rules are non-negotiable
When an exit rule fires, the UI must surface it with equal or greater prominence than any entry signal. Exit rules cannot be snoozed in code, only acknowledged. The system is more useful at preventing losses than finding winners; treat that asymmetry as a design constraint.

### 2.4 No fabricated metrics
Do not invent composite scores that aren't grounded in observable inputs. Specifically:
- ❌ No "Neutrality Index", "Conviction Score", "Sentiment Health", or similar synthetic gauges that average unrelated signals into a single number that looks authoritative.
- ✅ Confluence Score is allowed because it is a transparent weighted sum of named filings within a defined window. Its components must always be visible alongside it.
- ✅ The /funds strength label (Strong / Moderate / Weak / Net selling) is allowed because it is a printed threshold rule over counts of named 13F changes (`web/lib/fund-flow-rules.ts`). The rule text must stay on the page next to the labels.

If you find yourself reaching for a metric to make a UI element "feel" more decisive, stop. Show the raw signals.

### 2.5 The system not firing is the system working
There will be weeks where nothing surfaces. That is correct behavior. Do not add filler ("watchlist of the week", "interesting filings even though they didn't meet the threshold"). Empty state is honest.

### 2.6 Honest caveats
- 13F filings are 45 days delayed. Surface this everywhere a 13F-derived signal appears.
- Filer intent is not always inferable from a filing. Don't claim it is.
- Past activist outcomes do not predict future ones. The score is a heuristic, not a forecast.

---

## 3. Communication tone with this user

- Direct. No hedging filler. No "great question". No closing summary paragraphs that restate what just happened.
- Push back when you disagree. The user explicitly asks for this.
- When proposing UI or data choices that touch §2, name the principle being applied so drift is visible.
- Don't ask for permission on technical details that are downstream of decisions already in this doc. Do ask on decisions that change the philosophy.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  SEC EDGAR (public)        Price data (TBD: yfinance / polygon)│
└──────────────┬──────────────────────────┬──────────────────────┘
               │                          │
        ┌──────▼──────┐            ┌──────▼──────┐
        │  Ingestion  │            │   Quotes    │
        │  (Python)   │            │  (Python)   │
        └──────┬──────┘            └──────┬──────┘
               │                          │
               └──────────┬───────────────┘
                          │
                  ┌───────▼────────┐
                  │   Supabase     │
                  │  (Postgres+RLS)│
                  └───────┬────────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
       ┌──────▼─────┐ ┌──▼─────┐ ┌──▼──────────┐
       │ Confluence │ │Universe│ │  Exit Rule   │
       │   Scorer   │ │ Filter │ │   Engine     │
       └──────┬─────┘ └──┬─────┘ └──┬──────────┘
              │          │          │
              └──────────┼──────────┘
                         │
                  ┌──────▼──────┐
                  │   Next.js   │
                  │  (Vercel)   │
                  └─────────────┘
```

### Stack
- **Ingestion**: Python 3.11+, `requests`, `sec-edgar-downloader` or direct EDGAR API, `supabase-py`.
- **Database**: Supabase Postgres. Row-level security on. Schema in [schema/supabase.sql](schema/supabase.sql).
- **Scheduler**: GitHub Actions cron for polling (cadence in `config/signal_weights.yml`). Avoid long-running workers for v1.
- **Frontend**: Next.js (App Router) on Vercel. Server components read from Supabase via service role; no client-side DB access.
- **UI**: shadcn/ui on Tailwind v4 — dark theme, semantic signal color tokens, shared Neon components. The rules live in [web/AGENTS.md](web/AGENTS.md); follow them for any new UI.
- **Auth**: Single-user. Supabase magic-link, RLS scoped to one `user_id`.

---

## 5. Data model (see schema/supabase.sql for SQL)

- `tracked_filers` — the universe of 13F/13D filers we watch (CIK, name, category, multiplier).
- `filings_raw` — every fetched filing, deduped by accession number. Source of truth.
- `holdings_13f` — flattened per-position rows from 13F-HR/A filings, as reported (includes options and bond principal).
- `holdings_13f_effective` (materialized view; the rule itself is the view `holdings_13f_effective_live`) — the rows every reader uses: a filer's actual long-equity holdings per quarter. Refreshed by `refresh_holdings_effective()` (§6.1).
- `events_13d` — 13D/G filings parsed for activist stake disclosures.
- `events_form4` — insider transactions.
- `insider_transactions` — universe-wide Form 4 open-market buys the scorer reads for insider clusters (§6.3), with `is_10b5_1`, `shares_owned_after`, `direct_indirect` (migration 024).
- `tickers` — the investable universe with the latest snapshot of price + return windows, plus Yahoo `industry` / `sector` labels (migration 027).
- `stock_splits` — split history (ratio = new shares per old share), so splits don't read as adds or trims.
- `fund_position_changes` — what each fund did to each stock between its own consecutive 13F filings (opened / added / trimmed / exited). Read only through the `fund_flows()` SQL function (§6.1a).
- `stock_signal_extras` — insider-cluster and activist-13D columns for /funds, computed with the v6 scorer's rules.
- `signals` — emitted entry signals with score breakdown stored as JSONB.
- `exit_signals` — emitted exit signals against user positions.
- `user_positions` — what the user currently holds. Drives exit-rule monitoring.
- `signal_acknowledgements` — append-only log of user actions on signals (acknowledged / dismissed / acted-on). Never delete signals; always log the decision.

---

## 6. Signal extraction

### 6.0 Filer curation logic (read before adding or removing from the list)

**Inclusion rule (revised):** include a filer if their 13F-disclosed positions are *thesis-driven* (a human deliberately chose them) — even if 13F only captures a small fraction of their total book. Use a per-filer `coverage_pct` annotation in `web/lib/filers.ts` to record what fraction is visible. Downstream scoring multiplies signal weight by `coverage_pct`, so a Bridgewater 13F-new contributes less than a Buffett one *without being silently dropped*.

**Hard exclusion (just one):** filers whose disclosed positions are **algorithmic baskets, not thesis picks** — labeled `signal_class: algorithmic_basket`. No human at RenTech, Citadel's stat-arb desk, or pure market-makers said "this stock will go up." Their disclosed 13Fs are mechanical outputs of their strategies, not signals about individual companies.

**Curation history:**

- **ARK (Wood)** — dropped: originally included only for the daily-trade CSV property, which ARK has since restricted. Without daily granularity the quarterly 13F adds little given recent stock-picking record.
- **Renaissance Technologies** — excluded permanently: `algorithmic_basket`. Even at 100% coverage no human chose these positions individually.
- **Citadel / Millennium / Two Sigma equity desks** — same exclusion class as RenTech.
- **Bridgewater (Dalio), Hayman (Bass), Druckenmiller** — INCLUDED with low `coverage_pct` (5-30%). Their 13F slices are small but represent intentional positions worth surfacing, just at proportional weight.

If a future maintainer wants to add or remove a filer, the test is:
1. Are the 13F positions *thesis-driven* (human chose each)? If no → exclude under `algorithmic_basket`.
2. What fraction of their book does 13F capture? → annotate `coverage_pct`.
3. Recent track record? → use to inform `multiplier`, not as a gate.

### 6.1 13F-HR (45-day delay; surface this caveat in UI)
- Diff each filer's current 13F vs prior. Emit `new_position`, `add`, `trim`, `exit`.
- A position is "new" if the ticker wasn't in the prior 13F. Adds/trims are ≥10% share-count change.
- **Read holdings only through `holdings_13f_effective`** (rule: migration 023, now the view `holdings_13f_effective_live`; readers use the stored copy from migration 025). **Anything that writes `holdings_13f` must refresh the stored copy afterwards** with `ingest.holdings_effective.refresh()` (`parse_13f` and `backfill_tickers` do; by hand: `python -m ingest.holdings_effective`), or readers keep seeing the old rows. Don't call the `refresh_holdings_effective()` RPC through PostgREST: its statement timeout cancels the refresh. Per (filer, quarter) it takes the latest original-or-RESTATEMENT filing that has rows, plus NEW HOLDINGS amendments filed after it, and drops put/call rows and PRN rows (`sh_type`; bond principal in dollars, not shares). A RESTATEMENT replaces the original; a NEW HOLDINGS amendment only adds the positions the filer had kept confidential (Berkshire Q1-2025: 110 + 4), minus rows that copy the base or an earlier amendment. A "NEW HOLDINGS" that repeats at least half of the base's securities (and at least 5) is a mislabelled full re-list and counts as a RESTATEMENT (in the 35 amendments on file, true NEW HOLDINGS repeat 0–1 securities, re-lists 99–100%). Never dedupe "latest filing wins" in a reader — that drops the original when a NEW HOLDINGS amendment exists.

### 6.1a Fund flows (/funds)
- `ingest/compute_fund_flows.py` (nightly, after `cusip_resolver`) writes `fund_position_changes`; rules in `ingest/scoring_rules.py` (`fund_position_changes`, `stock_signal_extras`), tests in `tests/test_fund_flows.py`.
- Each fund's newest filing is compared with its own previous filing (lag 1; lag 2 = two filings back). Early filers count the day they file; a fund whose newest filing is older than the previous reporting quarter (latest quarter whose 45-day deadline has passed) is left out; a fund with a single filing records nothing.
- Added / trimmed = split-adjusted share change ≥ 10%. Tickers resolve through today's `cusip_ticker_map` for both quarters; a CUSIP the map can't resolve gets one ticker for every quarter, voted from its rows' stored tickers and issuer-name matches (`cusip_fallback_tickers`), so a filing that spells the issuer differently can't fake an exit + re-open. Only rows without a usable CUSIP fall back to their own stored ticker or name. CUSIPs are compared upper-case (`cusip_key`; some 13Fs write `48251w104`). When several tickers share a name (KKR / KKRT, SPAC unit / warrant / share), the name match picks one a fund's CUSIP already maps to, then the shortest, then alphabetical (`name_ticker_map`).
- `cusip_ticker_map` comes from OpenFIGI (`ingest/cusip_resolver.py`). Letter-first CUSIPs are CINS codes (non-US issuers: Chubb, Accenture, ASML) and must be sent as `ID_CINS`; as `ID_CUSIP` OpenFIGI finds nothing. CUSIPs are upper-cased before lookup. No-match rows are re-asked after 30 days, up to 300 per run.
- **All counting lives in `fund_flows()`** (migration 027): net funds, tier-weighted net (S 1.5 · A 1.2 · B 1.0 · C 0.7), conviction (share of each buying fund's 13F book), streak, and the tier/style/lag filters. Don't re-count in TypeScript or Python; extend the function and `tests/sql/fund_flows.test.mjs`.
- Split history older than 13 months comes from a one-time `python -m ingest.backfill_splits`; the nightly prices job adds new splits.

### 6.2 13D / 13G
- New 13D from a filer in the `activist` category → highest-weight signal in the system.
- 13G → lower weight; passive stake.
- Amendments (13D/A) parsed but weighted lower than initial.

### 6.3 Form 4 (insider transactions)
- Open-market buys (code P). Sales ignored.
- Every insider with an open-market buy of the ticker in the 30-day window counts toward the cluster. `insider_filters` in `config/signal_weights.yml` can narrow this (officer or director; not a Rule 10b5-1 plan buy; minimum total $; minimum stake growth), but all four are switched off by the user's choice. Do not switch them back on without asking.
- When a filter is on, buys are judged per insider, not per row; unknown inputs never exclude anyone; excluded insiders are stored in `components.insider_cluster.excluded` with the reason and shown on /signals (§2.4; that page is hidden for now as `web/app/signals/page.tsx.disabled`).
- Cluster scoring: 1 / 2 / 3+ qualifying insiders → 1.5 / 3.5 / 7.0 (+1 each beyond 3).
- SEC spells flags several ways ("1"/"true", "TenPercentOwner"); parse them with `ingest/form4_fields.py`, never with ad-hoc string checks.

### 6.4 Confluence scoring
For each ticker on each day, sum the weighted signals from the last `window_days` (see `config/signal_weights.yml`). Apply per-filer `multiplier`. Output:
```json
{
  "ticker": "XYZ",
  "score": 7.2,
  "components": [
    {"type": "13d_new", "filer": "Filer A", "weight": 3.0, "multiplier": 2.0},
    {"type": "form4_cluster", "count": 4, "weight": 1.2}
  ],
  "window_days": 30
}
```
Components must be persisted with the score. Never just store the score.

### 6.5 Universe filter (applied AFTER scoring, BEFORE surfacing as signal)
- Drop tickers with trailing 6-month return > `late_stage_threshold` (default `0.60`).
- Drop tickers below `min_market_cap` (default `$300M`) and below `min_avg_volume`.
- Surviving tickers with `score >= signal_threshold` become entry signals.

### 6.6 Exit rules (run daily against `user_positions`)
- Trailing stop hit (config'd per-position or default).
- Tracked filer fully exits the ticker.
- Score-based: confluence score for the ticker has fully decayed AND price is below entry.

Exit signals always surface. Always.

---

## 7. Build sequence

Tasks listed below in order. Each is a coherent unit of work. Mark in the repo's `PROGRESS.md` as you go.

1. **Cloud setup** (user-gated; needs credentials)
   - Create GitHub repo. User to run `gh repo create` or do it via web.
   - Create Supabase project. User logs in, creates project, supplies anon + service keys to `.env`.
   - Run `schema/supabase.sql` against the new Supabase project.
   - Create Vercel project linked to the GitHub repo.
   - Do NOT attempt to do any of this from a non-interactive session. Walk the user through.

2. **EDGAR ingestion module** (`ingest/edgar.py`)
   - Reads `config/tracked_filers.yml`.
   - For each filer with a CIK, fetches recent filings via EDGAR's filing index.
   - Idempotent: dedupes by `accession_number`. Writes raw filings to `filings_raw`.
   - Polite: 10 req/sec max (EDGAR rate limit), `User-Agent` header includes contact email.
   - Filers without a CIK: log a TODO; do not crash.

3. **Filing parsers** (`ingest/parsers/`)
   - `parse_13f.py` → `holdings_13f` rows.
   - `parse_13d.py` → `events_13d` rows.
   - `parse_form4.py` → `events_form4` rows.
   - Each parser is pure: input filing text, output rows. Tested with fixtures checked into `tests/fixtures/`.

4. **Confluence scorer** (`scoring/confluence.py`)
   - Pure function: `(ticker, asof_date, events, weights) -> ScoreResult`.
   - Persists into `signals` with components JSONB.

5. **Universe filter** (`scoring/universe.py`)
   - Daily price snapshot job populates `tickers`.
   - Filter pass tags rows as `tradeable | late_stage | too_illiquid`.
   - Only `tradeable` tickers can become entry signals.

6. **Exit rule engine** (`scoring/exit_rules.py`)
   - Runs daily. Reads `user_positions`. Emits to `exit_signals`.

7. **Frontend** (Next.js)
   - Three views only: **Signals**, **Positions/Exits**, **Filings log**.
   - No dashboards. No charts of your own portfolio's performance. No "trending".
   - Each signal row links to the underlying filing(s) on sec.gov.
   - Empty state explicitly says "no signals — this is normal" (see §2.5).

8. **GitHub Actions schedules**
   - Hourly: EDGAR poll (filings are infrequent; this is generous).
   - Daily 18:00 ET: price snapshot + universe filter + exit-rule run + signal emission.

---

## 8. Future layers — DO NOT BUILD NOW

The following are explicitly out of scope until v1 has been running for at least one full quarter. Do not pre-scaffold, pre-design, or "leave hooks for" these. YAGNI.

- Alt-data integrations (credit card panels, satellite, web scraping).
- LLM summaries of filings.
- LLM-generated rationale on signals.
- Multi-user / shared-watchlist features.
- Mobile app.
- Backtesting framework. (Exceptions: Lag7 and the earnings test — see the §2.2 notes.)
- Thematic aggregation views (hand-curated themes). Industry grouping from an external factual label (Yahoo industry on /funds) was approved by the user on 2026-10-03.

If the user asks for one of these, push back: "v1 isn't a quarter old yet; we don't know what's actually missing." Then build it only if they confirm.

---

## 9. Honest caveats to surface in product

- "13F data is 45 days delayed by law."
- "Filer intent is inferred, not stated. Read the filing."
- "Past activist returns do not predict future ones."
- "No signals this week is the expected state most weeks."

These strings live in the UI, not just this doc.

---

## 10. Working agreements for Claude Code

- Read this file at the start of every session.
- Before writing code that touches signal generation, scoring, or UI surfacing, restate which principle in §2 applies. One sentence.
- Never add a new composite metric without flagging §2.4.
- Never add a "discovery" or "trending" surface without flagging §2.2.
- If the user asks for a feature in §8, push back before implementing.
- Tests: parsers must have fixture-based tests. Scorers must have unit tests. UI does not need tests for v1. Run `python -m pytest -q`, `cd tests/sql && npm ci && node --test`, and `node --test --experimental-strip-types tests/web/*.test.mjs` (pure TS rules in `web/lib/fund-flow-rules.ts`; keep that file free of imports). Scoring changes: replay old vs new with `scripts/diff_signals.py` and account for every changed ticker.
- Commits: small, focused, conventional-commits style. One logical change per commit.
- Building UI: follow [web/AGENTS.md](web/AGENTS.md) — shadcn/ui components, semantic color tokens, never raw Tailwind palette colors.
- Recent changes and known open issues: [CHANGELOG.md](CHANGELOG.md). Add an entry when you change behavior others rely on.
- **Deploying = pushing to `main`.** The Vercel project is connected to this repo (root directory `web`): every push to `main` deploys to production, every other branch gets a preview URL. NEVER run `vercel --prod` by hand — production must always be what is on `main`. `scripts/deploy.sh "msg"` commits + pushes (and stamps an empty keep-alive commit when nothing changed). On `main` it first applies pending migrations to production (`python -m ingest.migrate`, needs `SUPABASE_PAT` in `.env`) and refuses to run if `schema/migrations` has uncommitted changes; on other branches it skips migrations. Merging a PR on GitHub skips this script, so apply a PR's migrations before merging it. Why commits matter beyond deploys: GitHub auto-disables the `daily-ingest` scheduled workflow after 60 days with no commits (this stalled ingestion for 2 weeks once — last commit 2026-06-02 → cron disabled ~2026-08-02). If the cron ever shows `disabled_inactivity` (`gh workflow list --all`), it needs a manual re-enable in the GitHub UI by a repo admin.
