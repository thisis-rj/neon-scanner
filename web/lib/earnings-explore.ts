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
