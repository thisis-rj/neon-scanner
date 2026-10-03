# Changelog

What changed, why, and what is still open. Newest first. Add an entry when you change behavior that someone else relies on.

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
