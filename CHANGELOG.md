# Changelog

What changed, why, and what is still open. Newest first. Add an entry when you change behavior that someone else relies on.

## 2026-10-03 — 13F holdings counted correctly; Form 4 fields fixed

Author: Vijay (with Claude). Branch `fix/data-correctness`, rebased onto `040906c`.

### 13F: one rule for "what a fund really holds"

- New view **`holdings_13f_effective`** (migration `023`). Per filer and quarter it takes the latest original-or-RESTATEMENT filing, adds NEW HOLDINGS amendments filed on or after it (minus rows that just copy the original or an earlier amendment; same-day ties go to the RESTATEMENT, then the later accession number). A "NEW HOLDINGS" amendment that repeats at least half of the original's securities (and at least 5) is a mislabelled full re-list and replaces the quarter like a RESTATEMENT, and drops put/call rows and bond principal (`sh_type = PRN`). Every reader uses it: the signal scorer, filer returns, cost basis, Stocks, and Holdings (through `holdings_recent()`).
- Why: options, bonds and amendments were counted as share purchases. Examples: Oaktree's convertible bonds made SNOW and RIOT look like big buys; Situational Awareness's call options hid MU going from 17k to 4.8M shares; First Eagle's mislabelled amendment doubled its Q2-2026 book.
- `parse_13f` now stores `sh_type` and the 13F-HR/A amendment type, pages filings in a stable order, leaves an amendment whose type it can't read unparsed (retried next run) instead of letting it replace the quarter, and removes a filing's rows if an insert fails partway. Release step: reparse all 13F filings once (`python -m ingest.parse_13f --reparse`).

### Form 4: insider fields

- Role flags were wrong on XML filings: SEC writes `"true"` as well as `"1"`, and bulk rows spell `TenPercentOwner` without separators. One parser for both now (`ingest/form4_fields.py`).
- New columns (migration `024`): `is_10b5_1`, `shares_owned_after`, `direct_indirect`. Release step: one-year bulk backfill (`python -m ingest.form4_universe_bulk --years 1`). The daily ingester now updates rows it already has instead of skipping them, so each nightly run refreshes its last 7 days; rows from the current quarter older than that are refreshed when SEC publishes the quarter's bulk file (the `dera-refresh` job). Until then some July–September 2026 rows keep the old role flags and empty new fields; no score uses them while the insider filters are off.
- **Every open-market insider buy still counts** (Vijay's call). Filters for officer/director, 10b5-1 plans, a $ minimum and stake growth exist in `config/signal_weights.yml` `insider_filters`, all switched **off**. This answers the TSM employee-plan question in the entry below: those buys keep counting.

### Process

- `scripts/deploy.sh` runs `python -m ingest.migrate` before it pushes, only on `main` and only when every file in `schema/migrations` is committed (other branches are previews and leave production's schema alone). **Merging a PR on GitHub skips this**: run the migrate yourself before merging a PR that adds a migration.
- CI: `tests.yml` runs pytest and the PGlite view tests on every push; the nightly SEC job runs pytest first.
- Migrations renumbered 019/020 → **023/024**: production already has `019`–`022` from the My Stocks portfolio work, whose files are not on `main` yet. **Riya: please push those four files.**

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
- **Pending on branch `fix/data-correctness`:** 13F data-correctness and insider filters, with schema migrations 019/020. Not merged. Its pages need migrations applied *before* deploy, and with push-to-deploy that ordering rule still has to be settled.
