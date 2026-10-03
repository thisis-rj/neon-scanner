// Pure rules for /funds: the strength label, URL parsing, filters, sorting and
// the industry rollup. No imports on purpose — tests/web/fund-flow-rules.test.mjs
// runs this file directly with `node --test --experimental-strip-types`.
// Counting (net, tier-weighted, conviction, streak) is NOT here: it lives in the
// fund_flows() SQL function (migration 025) so every view counts the same way.

export type FundEvent = "opened" | "added" | "trimmed" | "exited";

export type FundDetail = {
  cik: string;
  filer: string;
  tier: string;
  category: string | null;
  event: FundEvent;
  pct: number | null;
  shares_prev: number | null;
  shares_cur: number | null;
  split: number;
  period: string;
  prev_period: string;
};

/** One row of fund_flows(). Numeric columns arrive as numbers (or null). */
export type FlowRow = {
  ticker: string;
  name: string | null;
  industry: string | null;
  sector: string | null;
  market_cap_usd: number | null;
  avg_dollar_volume_20d: number | null;
  return_6mo: number | null; // fraction: 0.12 = +12%
  buyers: number;
  sellers: number;
  net: number;
  opened: number;
  added: number;
  trimmed: number;
  exited: number;
  tier_net: number;
  sa_buyers: number;
  conviction_max: number | null; // fraction of the fund's 13F book
  conviction_max_filer: string | null;
  conviction_sum: number | null;
  streak: number;
  min_period: string;
  max_period: string;
  insider_buyers: number;
  insider_names: string[];
  activist_filers: string[];
  activist_latest: string | null;
  funds: FundDetail[];
  computed_at: string | null;
};

// ─── Label ────────────────────────────────────────────────────────────────
// A visible threshold rule over counts (CLAUDE.md §2.4): the rule text below is
// printed on the page next to every label.

export type Label = "Strong" | "Moderate" | "Weak" | "Net selling";

// Tuned on live data 2026-10-03 (68 funds, Q2 2026): Strong covers 22 stocks
// with the previous-filing comparison (net ≥ 4 would give 10, net ≥ 5 just 5).
export const LABEL_RULE = {
  strongNet: 3,
  strongStreak: 2,
  moderateNet: 3,
  weakNet: 1,
  sellingNet: -2,
} as const;

export const LABEL_RULE_TEXT: { label: Label; rule: string }[] = [
  {
    label: "Strong",
    rule: `net ≥ ${LABEL_RULE.strongNet}, at least one S/A-tier fund buying, and net buying ${LABEL_RULE.strongStreak}+ quarters in a row`,
  },
  { label: "Moderate", rule: `net ≥ ${LABEL_RULE.moderateNet} (and not Strong)` },
  { label: "Weak", rule: `net ${LABEL_RULE.weakNet}–${LABEL_RULE.moderateNet - 1}` },
  { label: "Net selling", rule: `net ≤ ${LABEL_RULE.sellingNet}` },
];

export function label(r: Pick<FlowRow, "net" | "sa_buyers" | "streak">): Label | null {
  if (r.net >= LABEL_RULE.strongNet && r.sa_buyers >= 1 && r.streak >= LABEL_RULE.strongStreak) return "Strong";
  if (r.net >= LABEL_RULE.moderateNet) return "Moderate";
  if (r.net >= LABEL_RULE.weakNet) return "Weak";
  if (r.net <= LABEL_RULE.sellingNet) return "Net selling";
  return null;
}

const LABEL_RANK: Record<string, number> = { Strong: 4, Moderate: 3, Weak: 2, none: 1, "Net selling": 0 };
const labelRank = (r: FlowRow) => LABEL_RANK[label(r) ?? "none"];

// ─── URL parameters ───────────────────────────────────────────────────────

export const TIERS = ["S", "A", "B", "C"] as const;
export const CATEGORIES = ["value", "concentrated", "growth", "activist", "macro", "corporate_strategic"] as const;
export const UNCLASSIFIED = "Unclassified";

export const STOCK_SORTS = [
  "label", "net", "tier_net", "conviction_max", "conviction_sum", "streak",
  "insiders", "activist", "market_cap", "return_6m", "latest_filing",
] as const;
export type StockSort = (typeof STOCK_SORTS)[number];

export const ROLLUP_SORTS = ["total_net", "net_bought", "net_sold", "industry"] as const;
export type RollupSort = (typeof ROLLUP_SORTS)[number];

export type Dir = "asc" | "desc";
export type LabelFilter = Label | "none" | null;

export type Filters = {
  view: "industries" | "stocks";
  industry: string | null;
  tiers: string[] | null; // null = all funds
  categories: string[] | null;
  lag: 1 | 2;
  minNet: number | null;
  capMinM: number | null; // market cap, $ millions
  capMaxM: number | null;
  volMinM: number | null; // 20-day average dollar volume, $ millions
  ret6MinPct: number | null; // trailing 6-month return, percent
  ret6MaxPct: number | null;
  label: LabelFilter;
  watchlist: boolean;
  sort: StockSort | RollupSort;
  dir: Dir;
};

export type Params = Record<string, string | string[] | undefined>;

function one(p: Params, key: string): string | undefined {
  const v = p[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s.trim() === "" ? undefined : s.trim();
}

function num(p: Params, key: string): number | null {
  const s = one(p, key);
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function list<T extends string>(p: Params, key: string, allowed: readonly T[]): T[] | null {
  const s = one(p, key);
  if (!s) return null;
  const vals = s.split(",").map((x) => x.trim()).filter((x): x is T => (allowed as readonly string[]).includes(x));
  return vals.length ? Array.from(new Set(vals)) : null;
}

/** Search params → Filters. Anything malformed falls back to the default. */
export function parseParams(p: Params): Filters {
  const industry = one(p, "industry") ?? null;
  const view = industry || one(p, "view") === "stocks" ? "stocks" : "industries";
  const sorts: readonly string[] = view === "stocks" ? STOCK_SORTS : ROLLUP_SORTS;
  const sortParam = one(p, "sort");
  const sort = (sortParam && sorts.includes(sortParam) ? sortParam : view === "stocks" ? "label" : "total_net") as
    | StockSort
    | RollupSort;
  const dirParam = one(p, "dir");
  let dir: Dir = dirParam === "asc" || dirParam === "desc" ? dirParam : defaultDir(sort);
  // §2.2: never rank stocks by how much they've already run up.
  if (sort === "return_6m") dir = "asc";
  const labelParam = one(p, "label");
  const labelFilter: LabelFilter =
    labelParam === "none" || LABEL_RULE_TEXT.some((l) => l.label === labelParam) ? (labelParam as LabelFilter) : null;
  return {
    view,
    industry,
    tiers: list(p, "tier", TIERS),
    categories: list(p, "style", CATEGORIES),
    lag: one(p, "quarters") === "2" ? 2 : 1,
    minNet: num(p, "min_net"),
    capMinM: num(p, "cap_min"),
    capMaxM: num(p, "cap_max"),
    volMinM: num(p, "vol_min"),
    ret6MinPct: num(p, "ret6_min"),
    ret6MaxPct: num(p, "ret6_max"),
    label: labelFilter,
    watchlist: one(p, "watch") === "1",
    sort,
    dir,
  };
}

/** Ascending first for things where small is the interesting end. */
export function defaultDir(sort: string): Dir {
  return sort === "industry" || sort === "market_cap" || sort === "return_6m" ? "asc" : "desc";
}

/** Filters → query string, with overrides (null removes a key). Keeps only non-defaults. */
export function toQuery(f: Filters, overrides: Record<string, string | null> = {}): string {
  const q: Record<string, string> = {};
  if (f.view === "stocks" && !f.industry) q.view = "stocks";
  if (f.industry) q.industry = f.industry;
  if (f.tiers) q.tier = f.tiers.join(",");
  if (f.categories) q.style = f.categories.join(",");
  if (f.lag === 2) q.quarters = "2";
  const nums: [string, number | null][] = [
    ["min_net", f.minNet], ["cap_min", f.capMinM], ["cap_max", f.capMaxM], ["vol_min", f.volMinM],
    ["ret6_min", f.ret6MinPct], ["ret6_max", f.ret6MaxPct],
  ];
  for (const [k, v] of nums) if (v !== null) q[k] = String(v);
  if (f.label) q.label = f.label;
  if (f.watchlist) q.watch = "1";
  const defaultSort = f.view === "stocks" ? "label" : "total_net";
  if (f.sort !== defaultSort || f.dir !== defaultDir(f.sort)) {
    q.sort = f.sort;
    q.dir = f.dir;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete q[k];
    else q[k] = v;
  }
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : "";
}

/** Query for clicking a column header: same column flips direction, a new one starts at its default. */
export function sortQuery(f: Filters, key: string): string {
  const dir: Dir = f.sort === key ? (f.dir === "desc" ? "asc" : "desc") : defaultDir(key);
  return toQuery(f, { sort: key, dir: key === "return_6m" ? "asc" : dir });
}

// ─── Filters (tier, style and quarters are applied in SQL) ─────────────────

export function industryOf(r: Pick<FlowRow, "industry">): string {
  return r.industry ?? UNCLASSIFIED;
}

/** Rows that pass the page filters. Rows with an unknown value fail a filter on that value. */
export function applyFilters(rows: FlowRow[], f: Filters, watchlist: Set<string> = new Set()): FlowRow[] {
  return rows.filter((r) => {
    if (f.industry && industryOf(r) !== f.industry) return false;
    if (f.minNet !== null && r.net < f.minNet) return false;
    const cap = r.market_cap_usd;
    if (f.capMinM !== null && (cap === null || cap < f.capMinM * 1e6)) return false;
    if (f.capMaxM !== null && (cap === null || cap > f.capMaxM * 1e6)) return false;
    const vol = r.avg_dollar_volume_20d;
    if (f.volMinM !== null && (vol === null || vol < f.volMinM * 1e6)) return false;
    const ret = r.return_6mo;
    if (f.ret6MinPct !== null && (ret === null || ret * 100 < f.ret6MinPct)) return false;
    if (f.ret6MaxPct !== null && (ret === null || ret * 100 > f.ret6MaxPct)) return false;
    if (f.label === "none" && label(r) !== null) return false;
    if (f.label && f.label !== "none" && label(r) !== f.label) return false;
    if (f.watchlist && !watchlist.has(r.ticker)) return false;
    return true;
  });
}

// ─── Sorting ──────────────────────────────────────────────────────────────

function stockValue(r: FlowRow, key: StockSort): number | null {
  switch (key) {
    case "label": return labelRank(r);
    case "net": return r.net;
    case "tier_net": return r.tier_net;
    case "conviction_max": return r.conviction_max;
    case "conviction_sum": return r.conviction_sum;
    case "streak": return r.streak;
    case "insiders": return r.insider_buyers || null;
    case "activist": return r.activist_latest ? Date.parse(r.activist_latest) : null;
    case "market_cap": return r.market_cap_usd;
    case "return_6m": return r.return_6mo;
    case "latest_filing": return Date.parse(r.max_period);
  }
}

function cmp(a: number | null, b: number | null, dir: Dir): number {
  // Empty values always last, whichever direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir === "asc" ? a - b : b - a;
}

/** Sorted copy. Label sorts break ties by conviction Σ; every sort ends with ticker A→Z. */
export function sortRows(rows: FlowRow[], key: StockSort, dir: Dir): FlowRow[] {
  return [...rows].sort(
    (a, b) =>
      cmp(stockValue(a, key), stockValue(b, key), dir) ||
      (key === "label" ? cmp(a.conviction_sum, b.conviction_sum, "desc") : 0) ||
      a.ticker.localeCompare(b.ticker),
  );
}

// ─── Industry rollup ──────────────────────────────────────────────────────

export type IndustryRow = {
  industry: string;
  sector: string | null;
  stocks: number;
  netBought: number; // stocks with net > 0
  netSold: number; // stocks with net < 0
  totalNet: number;
  top: string[]; // up to 3 tickers in the default stock order
};

export function rollup(rows: FlowRow[]): IndustryRow[] {
  const groups = new Map<string, FlowRow[]>();
  for (const r of rows) {
    const k = industryOf(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return Array.from(groups, ([industry, g]) => ({
    industry,
    sector: g.find((r) => r.sector)?.sector ?? null,
    stocks: g.length,
    netBought: g.filter((r) => r.net > 0).length,
    netSold: g.filter((r) => r.net < 0).length,
    totalNet: g.reduce((s, r) => s + r.net, 0),
    top: sortRows(g.filter((r) => r.net > 0), "label", "desc").slice(0, 3).map((r) => r.ticker),
  }));
}

export function sortRollup(rows: IndustryRow[], key: RollupSort, dir: Dir): IndustryRow[] {
  const val = (r: IndustryRow) =>
    key === "net_bought" ? r.netBought : key === "net_sold" ? r.netSold : key === "total_net" ? r.totalNet : 0;
  return [...rows].sort((a, b) => {
    if (key === "industry") return dir === "asc" ? a.industry.localeCompare(b.industry) : b.industry.localeCompare(a.industry);
    return cmp(val(a), val(b), dir) || a.industry.localeCompare(b.industry);
  });
}

// ─── Quarter range (D5: each fund's own latest filing) ─────────────────────

/** "Q2 2026" from "2026-06-30". */
export function quarterName(iso: string): string {
  const [y, m] = iso.slice(0, 10).split("-").map(Number);
  return `Q${Math.ceil(m / 3)} ${y}`;
}

/** Which quarters the counted funds' newest filings cover, and how many funds are on each. */
export function quarterCoverage(rows: FlowRow[]): { period: string; funds: number }[] {
  const byPeriod = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const f of r.funds) {
      const p = f.period.slice(0, 10);
      if (!byPeriod.has(p)) byPeriod.set(p, new Set());
      byPeriod.get(p)!.add(f.cik);
    }
  }
  return Array.from(byPeriod, ([period, ciks]) => ({ period, funds: ciks.size })).sort((a, b) =>
    b.period.localeCompare(a.period),
  );
}
