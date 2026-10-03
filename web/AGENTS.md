<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Neon UI system — read before building or changing any UI

The frontend was rebuilt on **shadcn/ui** on 2026-10-03 (see `/CHANGELOG.md`). Every new page, tab or component uses this system. The shadcn agent skill is installed at `/.claude/skills/shadcn`; follow its rules too.

## Building blocks

| Need | Use |
|---|---|
| Any standard control | `components/ui/*` (shadcn, radix base, style `radix-nova`, lucide icons). Missing one? `npx shadcn@latest add <name>` from `web/`, then **read the generated file** — this style's APIs differ from older shadcn (e.g. `Badge` variants, `Tabs` `variant="line"`, `Button` sizes `xs`/`icon-xs`, `Card size="sm"`). |
| Page title + explainer + facts row | `components/app/page-header.tsx` → `PageHeader` |
| Titled card holding a full-bleed table | `components/app/table-card.tsx` → `TableCard` |
| Table cells | `components/app/cells.tsx` → `Pct` (signed %, colored), `TierBadge` (S/A/B/C), `SecLink` (sec.gov ↗), `DateCell`, `Ticker`, `Hint` (dotted label + tooltip), `ThirteenFDelayNote` |
| Numbers | `lib/format.ts` → `fmtUsd`, `fmtUsdExact`, `fmtShares`, `fmtSharesExact`, `fmtSignedPct`, `daysAgo`, `shortDate`. Don't write new per-page formatters. |
| Charts | `components/ui/chart.tsx` (shadcn, recharts) — see `components/app/mag7/*-chart.tsx`. Series colors `--chart-1..3` only, in that fixed order; legend + table always present. |
| Nav | add the route to `NAV` in `components/app/site-header.tsx` (desktop + mobile menu both read it) |
| Empty / error / loading | `Empty` component · `app/error.tsx` · `app/loading.tsx` (already global) |

## Colors — tokens only

Theme lives in `app/globals.css`: light tokens in `:root`, dark in `.dark`. Dark is the default; the header's sun/moon button (`components/app/theme-toggle.tsx`, via `next-themes`) switches and remembers the choice. Every new color must work in **both** themes — check each page in light mode too. **Never use raw Tailwind palette colors** (`text-emerald-300`, `bg-neutral-900`, …). Use semantic tokens — each means exactly one thing everywhere:

| Token / Badge variant | Means |
|---|---|
| `positive` | buy, add, gain |
| `negative` | sell, exit, loss |
| `warning` | activist, trim, caution |
| `info` | portfolio / corporate-strategic / neutral info |
| `brand` | Neon chrome only (logo, active nav, focus). **Never** a signal. |
| `chart-1..3` | chart series identity only (validated set; never a signal) |
| `muted`, `muted-foreground`, `border`, `card`… | everything else |

## Page recipe

```tsx
export const dynamic = "force-dynamic"; // every page reads Supabase live

export default async function ThingPage() {
  const rows = await fetchThings(); // server-side via supabaseServer()
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Thing" description="What it shows, plainly." meta={<span>{rows.length} rows</span>} />
      <TableCard title="…" description="…">
        {rows.length === 0 ? <Empty>…</Empty> : <Table>…</Table>}
      </TableCard>
    </div>
  );
}
```

## Rules that keep it fast and honest

- Data fetching stays in **server components**. Interactive bits are small `"use client"` components (see `FilerCardTabs`, `TierFilter`, `WatchlistToggle`).
- `components/ui/table.tsx` is deliberately **not** `"use client"` — big tables would ship every cell to the browser. Keep it that way.
- Product rules from `/CLAUDE.md` §2 apply to UI: no trending / sorted-by-return surfaces (§2.2); sells/exits as prominent as buys (§2.3); a score always shows its components (§2.4); signal empty states say "this is normal" (§2.5); `ThirteenFDelayNote` wherever 13F data appears (§2.6).
- 13F holdings: read `holdings_13f_effective` (or the `holdings_recent()` RPC), never `holdings_13f` directly; the raw table still has options, bond principal and amendment duplicates (`/CLAUDE.md` §6.1).
- Hidden route = `page.tsx.disabled` (e.g. Signals). It is **not type-checked** while hidden; run `npx tsc --noEmit` after re-enabling.
- Check before pushing: `npx tsc --noEmit` and `npm run build`. Run locally with `web/.env.local` (see `web/.env.local.example`).

## Shipping

Push a branch → Vercel builds a **preview URL** (shown on the commit / PR in GitHub). Look at it, then merge to `main` → **production**. Never `vercel --prod`. If the branch adds a schema migration, apply it to production before merging: merging on GitHub doesn't migrate (see `/DEPLOY.md`).
