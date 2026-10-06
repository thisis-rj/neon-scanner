// Earnings-test explorer math — pure, no imports (tested by tests/web/earnings-explore.test.mjs).
//
// Each report carries its stock's daily returns from day R-30 to R+30 (R = the
// first session that can react to the report), and SPY's daily returns come
// from one shared series. Any "before" window and "after" window are rebuilt
// from those, so the page can answer "does the move over THESE days predict
// the move over THOSE days?" for any pair, instantly, in the browser.

export const PATH_DAYS = 30;
const N = 2 * PATH_DAYS + 1;
const MIN_PER_GROUP = 5;

export type ExploreEvent = {
  t: string; // ticker
  d: string; // reaction date (day 0)
  s: "bmo" | "intraday" | "amc"; // report session
  sec: string | null; // Yahoo sector
  sur: number | null; // EPS surprise %, known only AFTER the report
  src: "backtest" | "live";
  p: (number | null)[]; // 61 daily returns, units of 0.001%
  // Known before the report (null = not available):
  ib?: number | null; // insiders with open-market buys filed in the 90 days before
  v?: (number | null)[] | null; // volume on days -30..-1, % of normal
  m50?: number | null; // close at day -1 vs its 50-day average, minus 1
  m200?: number | null;
  mc?: number | null; // approximate market cap at the report (USD)
};

export type Prepared = {
  ev: ExploreEvent;
  season: string;
  stock: Float64Array; // daily return at day k → index k + 30 (NaN = not traded)
  spy: Float64Array;
  stockCum: Float64Array; // price at day k / price at day -1, minus 1
  spyCum: Float64Array;
};

export type Settings = {
  pre: [number, number]; // day offsets, inclusive, each in [-30, 30]
  post: [number, number];
  excess: boolean; // subtract SPY over the same days
  groups: number; // 3 / 5 / 10
  withinSeason: boolean; // rank within each earnings season (vs all reports together)
  session: "all" | "before" | "after"; // before = before open or intraday
  surprise: "all" | "beat" | "miss";
  sector: string; // "all" or a sector name
  cohort: "backtest" | "live" | "both";
};

export const DEFAULT_SETTINGS: Settings = {
  pre: [-10, -1],
  post: [0, 0],
  excess: true,
  groups: 5,
  withinSeason: true,
  session: "all",
  surprise: "all",
  sector: "all",
  cohort: "backtest",
};

export type Stats = {
  mean: number | null;
  t: number | null;
  seasons: number;
  positive: number;
};

export type GroupRow = {
  g: number;
  events: number;
  x: number; // average "before" return
  y: number; // average "after" return
  yMedian: number;
  upShare: number;
};

export type SeasonRow = {
  season: string;
  events: number;
  spread: number | null;
};

export type PathPoint = {
  day: number;
  top: number | null;
  bottom: number | null;
  all: number | null;
};

export type Result = {
  events: number;
  groups: GroupRow[];
  seasons: SeasonRow[];
  all: Stats;
  early: Stats;
  late: Stats;
  lateFrom: string | null; // first season of the later half
  sameSign: number | null;
  spearman: number | null;
  path: PathPoint[];
};

export function seasonOf(iso: string): string {
  return `${iso.slice(0, 4)}Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
}

function cumulative(r: Float64Array): Float64Array {
  const c = new Float64Array(N);
  c[PATH_DAYS - 1] = 0; // day -1 is the base
  for (let k = PATH_DAYS; k < N; k++) c[k] = (1 + c[k - 1]) * (1 + r[k]) - 1;
  for (let k = PATH_DAYS - 2; k >= 0; k--) c[k] = (1 + c[k + 1]) / (1 + r[k + 1]) - 1;
  return c;
}

/** Attach SPY's path and cumulative paths to each event. Events whose day 0 isn't in SPY's dates are dropped. */
export function prepare(events: ExploreEvent[], spyDates: string[], spyRet: number[]): Prepared[] {
  const at = new Map(spyDates.map((d, i) => [d, i]));
  const out: Prepared[] = [];
  for (const ev of events) {
    const i = at.get(ev.d);
    if (i == null) continue;
    const stock = new Float64Array(N);
    const spy = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const v = ev.p[k];
      stock[k] = v == null ? NaN : v / 100_000;
      const j = i + k - PATH_DAYS;
      spy[k] = j >= 0 && j < spyRet.length ? spyRet[j] : NaN;
    }
    out.push({
      ev,
      season: seasonOf(ev.d),
      stock,
      spy,
      stockCum: cumulative(stock),
      spyCum: cumulative(spy),
    });
  }
  return out;
}

/** Compounded return over day offsets a..b (inclusive); NaN if any day is missing. */
export function windowReturn(r: Float64Array, a: number, b: number): number {
  let g = 1;
  for (let k = a; k <= b; k++) {
    const v = r[k + PATH_DAYS];
    if (Number.isNaN(v)) return NaN;
    g *= 1 + v;
  }
  return g - 1;
}

export function meanT(xs: number[]): Stats {
  const k = xs.length;
  if (k === 0) return { mean: null, t: null, seasons: 0, positive: 0 };
  const m = xs.reduce((s, x) => s + x, 0) / k;
  const positive = xs.filter((x) => x > 0).length;
  if (k < 2) return { mean: m, t: null, seasons: k, positive };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (k - 1));
  return {
    mean: m,
    t: sd > 0 ? m / (sd / Math.sqrt(k)) : null,
    seasons: k,
    positive,
  };
}

function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; // ties share the average rank
    i = j + 1;
  }
  return r;
}

export function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  const rx = ranks(x);
  const ry = ranks(y);
  const n = x.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Group 1..G by "before" return (1 = lowest). Rows in groups too small to split get 0. */
function assignGroups(xs: number[], G: number): number[] {
  if (xs.length < G * MIN_PER_GROUP) return xs.map(() => 0);
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const g = new Array<number>(xs.length);
  order.forEach(([, i], rank) => (g[i] = Math.floor((rank * G) / xs.length) + 1));
  return g;
}

export function run(prepared: Prepared[], s: Settings): Result {
  const [a0, a1] = s.pre;
  const [b0, b1] = s.post;
  const rows: {
    x: number;
    y: number;
    season: string;
    p: Prepared;
    g: number;
  }[] = [];
  for (const p of prepared) {
    const e = p.ev;
    if (s.cohort !== "both" && e.src !== s.cohort) continue;
    if (s.session === "before" && e.s === "amc") continue;
    if (s.session === "after" && e.s !== "amc") continue;
    if (s.surprise === "beat" && !(e.sur != null && e.sur > 0)) continue;
    if (s.surprise === "miss" && !(e.sur != null && e.sur < 0)) continue;
    if (s.sector !== "all" && e.sec !== s.sector) continue;
    let x = windowReturn(p.stock, a0, a1);
    let y = windowReturn(p.stock, b0, b1);
    if (s.excess) {
      x -= windowReturn(p.spy, a0, a1);
      y -= windowReturn(p.spy, b0, b1);
    }
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    rows.push({ x, y, season: p.season, p, g: 0 });
  }

  const G = s.groups;
  if (s.withinSeason) {
    const by = new Map<string, number[]>();
    rows.forEach((r, i) => by.set(r.season, [...(by.get(r.season) ?? []), i]));
    for (const idx of by.values()) {
      const g = assignGroups(
        idx.map((i) => rows[i].x),
        G,
      );
      idx.forEach((i, j) => (rows[i].g = g[j]));
    }
  } else {
    assignGroups(
      rows.map((r) => r.x),
      G,
    ).forEach((g, i) => (rows[i].g = g));
  }

  const groups: GroupRow[] = [];
  for (let g = 1; g <= G; g++) {
    const rs = rows.filter((r) => r.g === g);
    if (rs.length === 0) continue;
    const ys = rs.map((r) => r.y);
    groups.push({
      g,
      events: rs.length,
      x: mean(rs.map((r) => r.x)),
      y: mean(ys),
      yMedian: median(ys),
      upShare: ys.filter((y) => y > 0).length / ys.length,
    });
  }

  const seasonNames = [...new Set(rows.map((r) => r.season))].sort();
  const seasons: SeasonRow[] = seasonNames.map((season) => {
    const rs = rows.filter((r) => r.season === season);
    const top = rs.filter((r) => r.g === G).map((r) => r.y);
    const bot = rs.filter((r) => r.g === 1).map((r) => r.y);
    return {
      season,
      events: rs.length,
      spread: top.length && bot.length ? mean(top) - mean(bot) : null,
    };
  });
  const scored = seasons.filter((x) => x.spread != null);
  const half = Math.ceil(scored.length / 2);
  const spreads = (xs: SeasonRow[]) => xs.map((x) => x.spread as number);

  const nz = rows.filter((r) => r.x !== 0 && r.y !== 0);
  return {
    events: rows.length,
    groups,
    seasons,
    all: meanT(spreads(scored)),
    early: meanT(spreads(scored.slice(0, half))),
    late: meanT(spreads(scored.slice(half))),
    lateFrom: scored[half]?.season ?? null,
    sameSign: nz.length ? nz.filter((r) => r.x > 0 === r.y > 0).length / nz.length : null,
    spearman: spearman(
      rows.map((r) => r.x),
      rows.map((r) => r.y),
    ),
    path: averagePath(rows, G, s.excess),
  };
}

function averagePath(rows: { p: Prepared; g: number }[], G: number, excess: boolean): PathPoint[] {
  const pick = {
    top: rows.filter((r) => r.g === G),
    bottom: rows.filter((r) => r.g === 1),
    all: rows,
  };
  const out: PathPoint[] = [];
  for (let k = 0; k < N; k++) {
    const pt: PathPoint = {
      day: k - PATH_DAYS,
      top: null,
      bottom: null,
      all: null,
    };
    for (const key of ["top", "bottom", "all"] as const) {
      let sum = 0;
      let n = 0;
      for (const r of pick[key]) {
        const v = excess ? r.p.stockCum[k] - r.p.spyCum[k] : r.p.stockCum[k];
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      pt[key] = n ? sum / n : null;
    }
    out.push(pt);
  }
  return out;
}

// ── "Answer" tab: the hypothesis asked directly ──────────────────────────────
// Does what a stock did in the days BEFORE a report (direction, size, shape)
// go with what it does AFTER (direction, size)? Every rule below is printed on
// the page next to its result.

export type AnswerSettings = {
  pre: [number, number];
  post: [number, number];
  excess: boolean;
  cohort: "backtest" | "live" | "both";
  only: string; // "all" or a CONTEXT key: keep only reports in that group
};

export const DEFAULT_ANSWER: AnswerSettings = {
  pre: [-10, -1],
  post: [0, 0],
  excess: false,
  cohort: "backtest",
  only: "all",
};

/** Groups by information other than the price move. `after` = known only once the report is out. */
export const CONTEXT = [
  { key: "cap_small", group: "Company size (at the report)", label: "Small cap", rule: "$300M–2B", after: false },
  { key: "cap_mid", group: "Company size (at the report)", label: "Mid cap", rule: "$2–10B", after: false },
  { key: "cap_large", group: "Company size (at the report)", label: "Large cap", rule: "$10–200B", after: false },
  {
    key: "cap_mega",
    group: "Company size (at the report)",
    label: "Mega cap (blue chip)",
    rule: "$200B+",
    after: false,
  },
  {
    key: "ins_yes",
    group: "Insider buying",
    label: "Insiders bought",
    rule: "1+ insider open-market buy filed in the 90 days before the report",
    after: false,
  },
  {
    key: "ins_no",
    group: "Insider buying",
    label: "No insider buys",
    rule: "none filed in the 90 days before",
    after: false,
  },
  {
    key: "vol_low",
    group: "Volume over the before window",
    label: "Quieter than normal",
    rule: "under 0.8× the normal daily volume",
    after: false,
  },
  {
    key: "vol_norm",
    group: "Volume over the before window",
    label: "Normal",
    rule: "0.8× to 1.25× normal",
    after: false,
  },
  { key: "vol_high", group: "Volume over the before window", label: "Busy", rule: "1.25× to 2× normal", after: false },
  {
    key: "vol_vhigh",
    group: "Volume over the before window",
    label: "Very busy",
    rule: "2× normal or more",
    after: false,
  },
  {
    key: "ma50_above",
    group: "Trend",
    label: "Above its 50-day average",
    rule: "last close before the report above the 50-day average",
    after: false,
  },
  { key: "ma50_below", group: "Trend", label: "Below its 50-day average", rule: "below it", after: false },
  {
    key: "ma200_above",
    group: "Trend",
    label: "Above its 200-day average",
    rule: "last close before the report above the 200-day average",
    after: false,
  },
  { key: "ma200_below", group: "Trend", label: "Below its 200-day average", rule: "below it", after: false },
  {
    key: "eps_miss",
    group: "EPS vs analysts' estimate",
    label: "Missed",
    rule: "reported EPS below the estimate",
    after: true,
  },
  { key: "eps_small", group: "EPS vs analysts' estimate", label: "Beat by 0–5%", rule: "", after: true },
  { key: "eps_mid", group: "EPS vs analysts' estimate", label: "Beat by 5–15%", rule: "", after: true },
  { key: "eps_big", group: "EPS vs analysts' estimate", label: "Beat by 15%+", rule: "", after: true },
] as const;

/** Average volume (% of normal) over before-window days a..b (only days -30..-1 are stored). */
export function volumeRatio(v: (number | null)[] | null | undefined, a: number, b: number): number | null {
  if (!v) return null;
  let sum = 0;
  let n = 0;
  for (let k = Math.max(a, -PATH_DAYS); k <= Math.min(b, -1); k++) {
    const x = v[k + PATH_DAYS];
    if (x != null) {
      sum += x;
      n++;
    }
  }
  return n ? sum / n / 100 : null;
}

/** Which CONTEXT groups a report belongs to, for the chosen before window. */
export function contextKeys(e: ExploreEvent, pre: [number, number]): string[] {
  const out: string[] = [];
  if (e.mc != null && e.mc >= 3e8)
    out.push(e.mc < 2e9 ? "cap_small" : e.mc < 1e10 ? "cap_mid" : e.mc < 2e11 ? "cap_large" : "cap_mega");
  if (e.ib != null) out.push(e.ib > 0 ? "ins_yes" : "ins_no");
  const vr = volumeRatio(e.v, pre[0], pre[1]);
  if (vr != null) out.push(vr < 0.8 ? "vol_low" : vr < 1.25 ? "vol_norm" : vr < 2 ? "vol_high" : "vol_vhigh");
  if (e.m50 != null) out.push(e.m50 > 0 ? "ma50_above" : "ma50_below");
  if (e.m200 != null) out.push(e.m200 > 0 ? "ma200_above" : "ma200_below");
  if (e.sur != null) out.push(e.sur < 0 ? "eps_miss" : e.sur < 5 ? "eps_small" : e.sur < 15 ? "eps_mid" : "eps_big");
  return out;
}

/** Reports in a row of a breakdown table, and what happened after. */
export type Cell = {
  events: number;
  upShare: number | null; // share whose after-move was up
  upNoise: number | null; // ± range of upShare that chance alone easily produces (95%)
  avg: number | null; // average after-move
  median: number | null;
  avgSize: number | null; // average |after-move|: how big, either way
};

export type BucketRow = Cell & { key: string; label: string };
export type ContextRow = Cell & { key: string; group: string; label: string; rule: string; after: boolean };
export type PatternRow = Cell & { key: string; label: string; rule: string };
export type Point = { x: number; y: number; t: string; d: string };

export type Answer = {
  events: number;
  all: Cell;
  beforeUp: Cell;
  beforeDown: Cell;
  dirDiff: number | null; // P(after up | before up) − P(after up | before down)
  dirNoise: number | null; // ± range of that difference from chance (95%)
  corrDirection: number | null; // rank correlation, before vs after
  corrSize: number | null; // rank correlation, |before| vs |after|
  corrNoise: number | null; // ± range of a correlation from chance (95%)
  buckets: BucketRow[];
  patterns: PatternRow[];
  context: ContextRow[];
  points: Point[];
};

export const BUCKETS = [
  { key: "fell_big", label: "Fell more than 10%", lo: -Infinity, hi: -0.1 },
  { key: "fell", label: "Fell 3–10%", lo: -0.1, hi: -0.03 },
  { key: "flat", label: "Within ±3%", lo: -0.03, hi: 0.03 },
  { key: "rose", label: "Rose 3–10%", lo: 0.03, hi: 0.1 },
  { key: "rose_big", label: "Rose more than 10%", lo: 0.1, hi: Infinity },
] as const;

export const PATTERNS = [
  { key: "up_days", label: "Rose most days", rule: "up on at least 70% of the days (3+ day window)" },
  { key: "down_days", label: "Fell most days", rule: "down on at least 70% of the days (3+ day window)" },
  { key: "jump_last", label: "Big jump on the last day", rule: "last day of the window up more than 3%" },
  { key: "drop_last", label: "Big drop on the last day", rule: "last day of the window down more than 3%" },
  {
    key: "dip_recover",
    label: "Dipped, then recovered",
    rule: "first half of the window down, second half up (4+ day window)",
  },
  {
    key: "rally_fade",
    label: "Rallied, then faded",
    rule: "first half of the window up, second half down (4+ day window)",
  },
  { key: "quiet", label: "Quiet", rule: "total move within ±2% and no single day beyond ±2%" },
] as const;

/** Which named patterns a window of daily returns matches (it can match several). */
export function patternsOf(days: number[]): string[] {
  const n = days.length;
  if (n === 0 || days.some((v) => Number.isNaN(v))) return [];
  const comp = (xs: number[]) => xs.reduce((g, v) => g * (1 + v), 1) - 1;
  const out: string[] = [];
  const ups = days.filter((v) => v > 0).length;
  const downs = days.filter((v) => v < 0).length;
  if (n >= 3 && ups / n >= 0.7) out.push("up_days");
  if (n >= 3 && downs / n >= 0.7) out.push("down_days");
  if (days[n - 1] > 0.03) out.push("jump_last");
  if (days[n - 1] < -0.03) out.push("drop_last");
  if (n >= 4) {
    const h = Math.floor(n / 2);
    const first = comp(days.slice(0, h));
    const second = comp(days.slice(h));
    if (first < 0 && second > 0) out.push("dip_recover");
    if (first > 0 && second < 0) out.push("rally_fade");
  }
  if (Math.abs(comp(days)) < 0.02 && days.every((v) => Math.abs(v) <= 0.02)) out.push("quiet");
  return out;
}

function cell(ys: number[]): Cell {
  const n = ys.length;
  if (n === 0) return { events: 0, upShare: null, upNoise: null, avg: null, median: null, avgSize: null };
  const p = ys.filter((y) => y > 0).length / n;
  return {
    events: n,
    upShare: p,
    upNoise: 1.96 * Math.sqrt((p * (1 - p)) / n),
    avg: mean(ys),
    median: median(ys),
    avgSize: mean(ys.map(Math.abs)),
  };
}

export function answer(prepared: Prepared[], s: AnswerSettings): Answer {
  const [a0, a1] = s.pre;
  const [b0, b1] = s.post;
  const xs: number[] = [];
  const ys: number[] = [];
  const pats: string[][] = [];
  const ctx: string[][] = [];
  const points: Point[] = [];
  for (const p of prepared) {
    if (s.cohort !== "both" && p.ev.src !== s.cohort) continue;
    const keys = contextKeys(p.ev, s.pre);
    if (s.only !== "all" && !keys.includes(s.only)) continue;
    let x = windowReturn(p.stock, a0, a1);
    let y = windowReturn(p.stock, b0, b1);
    const days: number[] = [];
    for (let k = a0; k <= a1; k++) {
      const v = p.stock[k + PATH_DAYS];
      days.push(s.excess ? v - p.spy[k + PATH_DAYS] : v);
    }
    if (s.excess) {
      x -= windowReturn(p.spy, a0, a1);
      y -= windowReturn(p.spy, b0, b1);
    }
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    xs.push(x);
    ys.push(y);
    pats.push(patternsOf(days));
    ctx.push(keys);
    points.push({ x, y, t: p.ev.t, d: p.ev.d });
  }

  const upY = ys.filter((_, i) => xs[i] > 0);
  const downY = ys.filter((_, i) => xs[i] <= 0);
  const beforeUp = cell(upY);
  const beforeDown = cell(downY);
  const n = xs.length;
  const both = beforeUp.upShare != null && beforeDown.upShare != null;
  return {
    events: n,
    all: cell(ys),
    beforeUp,
    beforeDown,
    dirDiff: both ? (beforeUp.upShare as number) - (beforeDown.upShare as number) : null,
    dirNoise: both ? Math.sqrt((beforeUp.upNoise as number) ** 2 + (beforeDown.upNoise as number) ** 2) : null,
    corrDirection: spearman(xs, ys),
    corrSize: spearman(xs.map(Math.abs), ys.map(Math.abs)),
    corrNoise: n >= 3 ? 1.96 / Math.sqrt(n) : null,
    buckets: BUCKETS.map((b) => ({
      key: b.key,
      label: b.label,
      ...cell(ys.filter((_, i) => xs[i] >= b.lo && xs[i] < b.hi)),
    })),
    patterns: PATTERNS.map((pt) => ({
      key: pt.key,
      label: pt.label,
      rule: pt.rule,
      ...cell(ys.filter((_, i) => pats[i].includes(pt.key))),
    })),
    context: CONTEXT.map((c) => ({
      key: c.key,
      group: c.group,
      label: c.label,
      rule: c.rule,
      after: c.after,
      ...cell(ys.filter((_, i) => ctx[i].includes(c.key))),
    })),
    points,
  };
}

// ── Wire format for /earnings-test/data (one compact row per report) ─────────
// [ticker, reactionDate, session, sectorIdx (-1 = none), surprise, live (0/1),
//  insiderBuyers, ma50Gap, ma200Gap, mcapMillions, path(61), volPath(30) | null]
export type WireRow = [
  string,
  string,
  ExploreEvent["s"],
  number,
  number | null,
  0 | 1,
  number | null,
  number | null,
  number | null,
  number | null,
  (number | null)[],
  (number | null)[] | null,
];
export type Wire = { sectors: string[]; spyDates: string[]; spyRet: number[]; rows: WireRow[] };

export function encodeEvent(e: ExploreEvent, sectorIdx: Map<string, number>): WireRow {
  const r4 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 1e4) / 1e4);
  return [
    e.t,
    e.d,
    e.s,
    e.sec == null ? -1 : (sectorIdx.get(e.sec) ?? -1),
    e.sur == null ? null : Math.round(e.sur * 100) / 100,
    e.src === "live" ? 1 : 0,
    e.ib ?? null,
    r4(e.m50),
    r4(e.m200),
    e.mc == null ? null : Math.round(e.mc / 1e6),
    e.p,
    e.v ?? null,
  ];
}

export function decodeEvents(w: Wire): ExploreEvent[] {
  return w.rows.map((r) => ({
    t: r[0],
    d: r[1],
    s: r[2],
    sec: r[3] < 0 ? null : w.sectors[r[3]],
    sur: r[4],
    src: r[5] ? "live" : "backtest",
    ib: r[6],
    m50: r[7],
    m200: r[8],
    mc: r[9] == null ? null : r[9] * 1e6,
    p: r[10],
    v: r[11],
  }));
}
