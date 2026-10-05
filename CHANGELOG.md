# Changelog

What changed, why, and what is still open. Newest first. Add an entry when you change behavior that someone else relies on.

## 2026-10-06 — /earnings-test: does the move before earnings predict the move after?

Author: Vijay (with Claude). Branch `feat/earnings-test`.

- New page **/earnings-test** (in the nav), three tabs. **Explorer:** pick any "before" and "after" window (day −30 to +30 around day 0, the first session that can react to the report), raw or minus SPY, 3/5/10 groups, ranked within each season or all together, filters for report time, EPS beat/miss and sector. Shows top − bottom group spread per season (with t and earlier-half vs later-half split), same-direction share, rank correlation, the average ±30-day path for top / bottom / all, a group table and per-season bars. All recomputed in the browser. **Fixed test:** the pre-registered rule (10 days before → reaction day and 20-day drift). **Live log:** upcoming reports written down before they happen, scored once prices exist; a row logged after its reaction session opened is marked late and not scored.
- Data: migration **`033`** (`earnings_test_events` with a 61-day `path` of daily returns per report, `earnings_test_spy`, `earnings_test_summary`). `python -m ingest.earnings_test --backfill` loaded 5 years (from 2021-10) for the 300 largest stocks on the Earnings tab; the nightly step `python -m ingest.earnings_test` logs, measures and re-scores.
- Caveats on the page: the backtest list is today's 300 largest (survivorship); costs are not included; the explorer finds chance patterns if you try enough windows, which is why it shows the two halves and why the live log is the real test.
- **Answer tab** (first tab, added after Vijay found the group/spread view hard to read): asks the hypothesis directly. Before window (day before … 30 days) and after window (reaction day / first week / first month / any), plain or minus SPY. Shows a plain verdict for direction → direction and size → size (each compared with the range chance alone produces), a rose-vs-fell table, a by-size table (fell >10% … rose >10%), named shape patterns with printed rules, and a scatter of every report. On the default windows (10 days before → reaction day, plain): rose before → up after 54.0%, fell before → 53.5% (no direction link); typical reaction 4.2% after a quiet run-up vs 7.6% / 6.2% after a >10% fall / rise (size link, correlation 0.09).
- Nav: a tab is now active only on its own path or sub-paths (`/earnings` no longer lights up on `/earnings-test`).

## 2026-10-05 — /funds: non-US stocks resolve; no more fake exit + re-open from name spellings

Author: Vijay (with Claude). Branch `fix/cins-cusips`.

- **Symptom:** /funds showed Berkshire exiting Chubb in Q1-2026 (−$10.7B) and re-opening it in Q2 (+$11.7B). It held 34,249,183 shares all three quarters.
- **Root cause, three layers:** (1) `cusip_resolver` sent every CUSIP to OpenFIGI as `ID_CUSIP`; letter-first codes are CINS (non-US issuers) and only match as `ID_CINS`, so all 806 were stored as `openfigi_nomatch`, and a no-match was never retried. (2) Without a CUSIP match, /funds fell back to the issuer name per row, per quarter; Berkshire's Q1-2026 13F wrote "CHUBB LTD SWITZ" (normalizes to `CHUBB SWITZ`, no match), so Chubb dropped out of that one quarter. (3) Same blind spot elsewhere: 16,189 holding rows (7 funds) carry lower-case CUSIPs (Akre: KKR as `48251w104`) that OpenFIGI and the map never matched, and 1,775 names map to several tickers (KKR and KKRT are both "KKR & Co. Inc."), picked by row order.
- **Fix:** `cusip_resolver` sends letter-first CUSIPs as `ID_CINS`, upper-cases CUSIPs, and re-asks no-match CUSIPs after 30 days (300 per run). /funds (`scoring_rules`) compares CUSIPs upper-case, gives an unmapped CUSIP one ticker for all quarters (`cusip_fallback_tickers`), and breaks name ties deterministically (`name_ticker_map`: a ticker some CUSIP maps to, then shortest, then alphabetical). Also fixed: the resolver's last-seen update failed every run on the `resolved_via` NOT NULL check (hidden by `continue-on-error`); `last_seen_in_holdings` had frozen at 2026-03-31.
- **Production data, done 2026-10-05:** re-asked all 3,191 no-match CUSIPs (letter-first 0 → 414 of 806 resolved; digit-first retries found 11), then resolved 1,005 upper-cased forms (672 matched). `cusip_ticker_map`: 8,306 → 8,978 rows. `compute_fund_flows` re-run with `main`'s code: Berkshire/Chubb events gone; Accenture, ASML, Seagate etc. now appear.
- **Measured with the branch's rules (dry run):** fake exit + same-shares re-open pairs $17.1B → $5.8B; /funds stocks 2,967 → 3,119; Akre's KKR position (was invisible) now shows its trims. These numbers reach production after merge (nightly job).
- Logs: `logs/cusip_resolver_cins_*`, `logs/cusip_resolver_upper_*` (gitignored, in the worktree).

## 2026-10-04 — Server functions run in Singapore, next to the database

Author: Vijay (with Claude). Branch `perf/sin1-region`.

- New `web/vercel.json` pins Vercel functions to **`sin1`** (Singapore). Supabase lives in `ap-southeast-1` (Singapore), but with no region set Vercel ran every page in `iad1` (Washington DC), so each database call crossed the Pacific: ~0.5 s per call. Measured before the change: Filings 7–10 s, Funds 4.6 s, Earnings 3 s, Holdings 30–38 s of server wait, almost all of it travel.
- Still open: Holdings makes 67 database calls per load, Filings downloads all ~8.5K filings to show 50, and `fund_flows()` re-runs once per 1,000 rows. Those are the next fixes.

## 2026-10-03 — /funds: which stocks the tracked funds are buying or leaving, by industry

Author: Vijay (with Claude). Branch `feat/fund-flows`. Spec and eng review: `~/Launcher/docs/neon-fund-flow-list-spec.md`.

- New page **/funds** (in the nav). First view: one row per industry (stocks net-bought, net-sold, total net funds). Click an industry for its stocks: label, net funds (buying − selling), tier-weighted net, conviction (share of each buying fund's 13F book), streak, insider buyers, activist 13Ds, market cap, 6-month return, and which funds moved. Filters for tier, fund style, previous vs two-filings-back, label, min net, market cap, dollar volume, 6-month return, watchlist. Every column header sorts; 6-month return sorts least-run-up first only (§2.2).
- Data: migration **`027`** adds `tickers.industry` / `sector`, `stock_splits`, `fund_position_changes`, `stock_signal_extras` and the `fund_flows()` function (all counting happens there). Nightly `python -m ingest.compute_fund_flows` after `cusip_resolver`; `prices.py` now saves Yahoo industry/sector and splits from calls it already makes (and skips them until migration 027 exists, because it runs in parallel with `ingest.migrate`).
- Rules: added/trimmed = split-adjusted share change ≥ 10%; each fund vs its own previous filing; funds that stopped filing and funds with a single filing are left out. Label: Strong = net ≥ 3 + an S/A-tier buyer + 2 quarters of net buying in a row (tuned on live data: 22 stocks); Moderate = net ≥ 3 otherwise; Weak = net 1–2; Net selling = net ≤ −2 (rule printed on the page).
- Known difference: the Holdings page's Bought/Sold tabs keep their own comparison (matched by company name, not split-adjusted), so they can disagree with /funds for the same fund (decided: leave as is).
- Production data loaded before release (2026-10-03/04): migration 027 applied; `python -m ingest.backfill_splits` once (5,365 split records for 1,813 fund-held tickers; 967 tickers Yahoo doesn't know are listed in `logs/backfill_splits_excluded_*.log`, re-run with `--only`); `prices.py` run once from the branch to fill industries (14.5% of /funds stocks still Unclassified, see TODOS); `compute_fund_flows` (68 funds, 2,967 stocks, 22 Strong). From now on the nightly job keeps all of it current.
- Share-class tickers use the dash spelling on /funds (`BRK-B`, not OpenFIGI's `BRK/B`) so they join prices, industry and splits.
- Signals and Clusters stay live until /funds has been checked on real data.

## 2026-10-03 — Light/dark toggle, Lag7 tab (Mag7 laggard sleeve)

Authors: Vijay (with Claude).

### Light / dark mode

- Sun/moon button in the header (`components/app/theme-toggle.tsx`, `next-themes`). Dark stays the default; the choice is remembered per browser. The light palette already existed in `globals.css`; it was just never switched on.

### Lag7 — personal Mag7 laggard sleeve tracker (`/lag7`)

- **Rule note:** `CLAUDE.md` §2.2 now has a note allowing this one personal ranked-by-return tracker; the same note is the exception for its equity chart (§7.7) and backfill (§8). Read it before building anything similar.
- **Rule:** month-end ranks of AAPL MSFT GOOGL AMZN NVDA META TSLA + SpaceX (SPCX, listed 2026-06-12) on 3/6/12-month total return; the **worst** average rank is bought (tie → lower return on the longest horizon each has). SpaceX is ranked only on the returns it has (3-month from the 2026-09-30 signal) — migration `031` makes those columns nullable. $100,000 sleeve switches on the next trading day, or holds. Tracks and recommends; never trades.
- **Data:** `ingest/mag7.py` (daily job step, after earnings) → migrations `030_mag7_sleeve.sql` (5 tables) + `031_lag7_spacex_sp500.sql`. Benchmark is the S&P 500 total return index (`^SP500TR`), not SPY. Signals, ranks and model trades are frozen once written. The sleeve starts 2025-01-01 (`SLEEVE_START`): first signal 2024-12-31, first model buy 2025-01-02; backfilled to 2026-09-30 (22 month-ends), all labelled `backtest`; a signal is `live` only if saved before its trade day closed. Falls back to Yahoo's chart API when yfinance is rate-limited. Tests: `tests/test_mag7.py`.
- **Your real trades:** typed in on the page (date, side, ticker, price, amount, shares — fill any two of the last three). Server refuses selling shares the ledger didn't buy and spending past $100,000. Writes need `MAG7_EDIT_PASSCODE` set on the server; unset = read-only. **Production needs it added in Vercel** (Riya's project).
- **Charts:** shadcn `chart` (recharts). New tokens `--chart-1..3` = series identity only, validated for colour-blind separation in both themes.

## 2026-10-03 — 13F holdings counted correctly; Form 4 fields fixed

Author: Vijay (with Claude). Branch `fix/data-correctness`, rebased onto `040906c`.

### 13F: one rule for "what a fund really holds"

- New view **`holdings_13f_effective`** (migration `023`). Per filer and quarter it takes the latest original-or-RESTATEMENT filing, adds NEW HOLDINGS amendments filed on or after it (minus rows that just copy the original or an earlier amendment; same-day ties go to the RESTATEMENT, then the later accession number). A "NEW HOLDINGS" amendment that repeats at least half of the original's securities (and at least 5) is a mislabelled full re-list and replaces the quarter like a RESTATEMENT, and drops put/call rows and bond principal (`sh_type = PRN`). Every reader uses it: the signal scorer, filer returns, cost basis, Stocks, and Holdings (through `holdings_recent()`). It is stored (materialized, migration `025`): as a plain view the Holdings page's 24 paged reads each re-ran the rule, 23 s vs 8.5 s before. `parse_13f` and `backfill_tickers` refresh it through `ingest/holdings_effective.py` (Management API; the REST path's statement timeout cancels the refresh); anything else that writes `holdings_13f` must too. By hand: `python -m ingest.holdings_effective`.
- Why: options, bonds and amendments were counted as share purchases. Examples: Oaktree's convertible bonds made SNOW and RIOT look like big buys; Situational Awareness's call options hid MU going from 17k to 4.8M shares; First Eagle's mislabelled amendment doubled its Q2-2026 book.
- `parse_13f` now stores `sh_type` and the 13F-HR/A amendment type, pages filings in a stable order, leaves an amendment whose type it can't read unparsed (retried next run) instead of letting it replace the quarter, and removes a filing's rows if an insert fails partway. Release step: reparse all 13F filings once (`python -m ingest.parse_13f --reparse`).

### Form 4: insider fields

- Role flags were wrong on XML filings: SEC writes `"true"` as well as `"1"`, and bulk rows spell `TenPercentOwner` without separators. One parser for both now (`ingest/form4_fields.py`).
- New columns (migration `024`): `is_10b5_1`, `shares_owned_after`, `direct_indirect`. Release step: one-year bulk backfill (`python -m ingest.form4_universe_bulk --years 1`). The daily ingester now updates rows it already has instead of skipping them, so each nightly run refreshes its last 7 days; rows from the current quarter older than that are refreshed when SEC publishes the quarter's bulk file (the `dera-refresh` job). Until then some July–September 2026 rows keep the old role flags and empty new fields; no score uses them while the insider filters are off.
- **Every open-market insider buy still counts** (Vijay's call). Filters for officer/director, 10b5-1 plans, a $ minimum and stake growth exist in `config/signal_weights.yml` `insider_filters`, all switched **off**. This answers the TSM employee-plan question in the entry below: those buys keep counting.

### Process

- `scripts/deploy.sh` runs `python -m ingest.migrate` before it pushes, only on `main` and only when every file in `schema/migrations` is committed (other branches are previews and leave production's schema alone). **Merging a PR on GitHub skips this**: run the migrate yourself before merging a PR that adds a migration.
- CI: `tests.yml` runs pytest and the PGlite view tests on every push; the nightly SEC job runs pytest first.
- Migrations renumbered 019/020 → **023/024**: production already has `019`–`022` from the My Stocks portfolio work. **Those four files are now on `main`** — see the My Stocks entry below.

## 2026-10-03 — My Stocks: real portfolio, pocket-return band, holdings protection

Authors: Riya (with Claude), rebuilt on top of Vijay's `040906c` shadcn redesign.

### My Stocks is now a live transaction-ledger portfolio (was an empty tab)

- **Transaction model.** Net qty, average cost, realized P&L and win rate are **derived from a buy/sell ledger** (`portfolio_transactions`), so partial sells, averaging up/down and multiple lots per stock all work. Buy-more / Sell (incl. a 50% quick button) write to the ledger from each holding's ▸ menu; per-stock target price + shared notes persist to `portfolio_positions`.
- **Closed trades** show below a red "Sold" divider with win rate + realized P&L. Open positions reconcile to the broker's current holdings; a few opening lots predate our earliest record (Dec 2025), so realized P&L / win rate on some closed names is flagged approximate. Basis-less sells (no recorded buy) are omitted rather than shown as phantom gains.
- **Overall pocket-return band (₹).** Return is measured the honest way — **current portfolio value (USD→INR at today's rate) vs net cash actually deposited from pocket**, not against cost basis (which includes reinvested earnings). Cash flows live in `portfolio_cashflows`; USD/INR in `fx_rates`, refreshed by the daily price job. This is a transparent cash-flow metric with its components shown (deposited / withdrawn / value) — not a §2.4 fabricated score, and it lives on this personal tab only, never in the signal views. **Riya's deposits are provisional** (read off INDmoney screenshots) until confirmed against the broker's "total added".
- Built entirely on Vijay's shadcn system (`ui/*`, `app/*`, `lib/format`, semantic tokens) — no raw palette colors. New shared formatters: `fmtUsdExact`, `fmtInr`, `fmtQty`.

### Data model

- New tables (migrations `019`–`022`): `portfolio_positions` (metadata + current price), `portfolio_transactions` (the ledger), `portfolio_cashflows` (pocket deposits/withdrawals, INR), `fx_rates` (USD/INR). Applied via `python -m ingest.migrate`.

### Security: real holdings can no longer leak

- **`ingest/portfolio_holdings.py` holds the real holdings and is now gitignored**; `ingest/portfolio.py` imports it (and no longer contains any real data), so it is safe to commit. Previously the holdings sat inline in an untracked-but-not-ignored file — one `git add -A` (which `deploy.sh` runs) would have published them.
- `python -m ingest.portfolio --prices` (daily price + USD/INR refresh) is **DB-driven and needs no holdings file**, so CI and other clones run it fine.

## 2026-10-03 — Deploy on push, shadcn/ui redesign, three bug fixes

Authors: Vijay (with Claude), on top of Riya's `7cae894`–`4297ad4` (My Stocks tab, Signals hidden, env templates, README onboarding).

### Deploys: pushing to `main` is the deploy

- Repo moved from `solveandbuild-source/neon-scanner` to **`thisis-rj/neon-scanner`**. Update old clones: `git remote set-url origin https://github.com/thisis-rj/neon-scanner.git`.
- The Vercel project (`neon-scanner`, Riya's account) is Git-connected with root directory `web`. **Push to `main` → production. Any other branch → a preview URL.** Collaborator commits deploy too (tested with a `vijaydhingra97` commit).
- `scripts/deploy.sh` no longer runs `vercel --prod`. It only commits and pushes, plus an empty keep-alive commit when nothing changed (GitHub disables the ingest cron after 60 days without commits). Never run `vercel --prod` by hand: production must always equal `main`.
- Preview deployments get `SUPABASE_URL` and `SUPABASE_SECRET_KEY` too, and preview URLs open without a Vercel login.
- Docs: `CLAUDE.md` §10, `DEPLOY.md`, `README.md`.

### UI: every page rebuilt on shadcn/ui

Same data, same queries. Only presentation changed. **New UI must follow [`web/AGENTS.md`](web/AGENTS.md).**

- Design system: shadcn/ui (radix base) on Tailwind v4. The dark theme is defined as tokens in `web/app/globals.css`. Semantic signal colors: `positive` = buy, `negative` = sell/exit, `warning` = activist, `info` = portfolio, `brand` violet = app chrome only.
- Shared pieces: `SiteHeader` (active-page nav, mobile menu), `PageHeader`, `TableCard`, table cells (`Pct`, `TierBadge`, `SecLink`, …), one set of number formatters in `lib/format.ts`.
- Footer shows all four `CLAUDE.md` §9 caveats (it used to show two).
- Global `loading.tsx` skeleton. Global `error.tsx` that says a failed read is an error, not an empty result.
- Per page:
  - **Filings:** the header shows the newest filing's age and turns amber after 7 days, so a stalled ingest is visible.
  - **Holdings:** Card + Tabs per filer, with Bought and Sold at equal weight. The tier filter is a ToggleGroup. The column legend moved into a "Column guide" hover card. Shares and Mark/sh now sit under the issuer name and the value.
  - **Corporate events:** 8-K headlines are marked as auto-summaries.
  - **Earnings:** grouped by report date (still date-ordered, never by return).
  - **Learn:** sticky section nav. "How to use" now matches the current pages.
  - **My Stocks:** Riya's page restyled (Tabs + Empty), same structure.
- Signals stays hidden as Riya chose. Its redesigned version is in `web/app/signals/page.tsx.disabled`, ready if re-enabled. The broken "View deep analysis" link (it pointed at the disabled `/signals/analysis`) is gone.
- shadcn agent skills installed in `.claude/skills/` (`shadcn`, `migrate-radix-to-base`), so Claude sessions know the component rules.

### Fixes

- **Holdings Δ shares showed "NEW" on every row.** The prior-quarter map is keyed by normalized issuer name, but the lookup passed the CUSIP. On identical data: 808 NEW cells before the fix, 125 after.
- **Signals "computed" date was weeks stale.** `signals_latest.computed_at` defaulted to `now()` on INSERT only, so tickers that kept signaling kept their first-seen date. `ingest/compute_buy_signals.py` now stamps every upsert. This was a display bug: the job had been running nightly.
- **White page under an OS light theme.** The old `globals.css` switched the page background on `prefers-color-scheme` while pages hard-coded dark cards. The app is now dark-only.
- The Learn page dropped spaces after bold text ("does nottell"). Fixed with explicit `{" "}`.

### Known open issues (not fixed yet)

- **8-K summaries fail every night.** Groq returns 404 for model `llama-3.3-70b-versatile` (no longer available). The step is `continue-on-error`, so the workflow still shows green. Decision pending: switch model, or drop LLM summaries, which `CLAUDE.md` §8 lists as out of scope.
- **Possible employee-plan noise in insider clusters.** Example: TSM showed "30 insiders" each buying 32–56 shares at the identical price on one day (~$122K total). That looks like a share plan, not discretionary buying (a guess), and it inflates TSM's signal score. Any filter would change scoring, so it needs a decision.
- **Holdings takes ~18 s to load** (production build, before and after the redesign): Supabase fetches dominate.
- **Railway GitHub app** was installed on the old repo. Its purpose and whether anything live depended on it are unknown.
- ~~**Pending on branch `fix/data-correctness`:** 13F data-correctness and insider filters, with schema migrations 019/020.~~ Shipped in the entry above: migrations renumbered 023–026, and `scripts/deploy.sh` migrates before pushing.
