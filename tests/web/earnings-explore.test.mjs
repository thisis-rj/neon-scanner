// Tests for web/lib/earnings-explore.ts — the /earnings-test explorer math.
//   node --test --experimental-strip-types tests/web
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  PATH_DAYS,
  meanT,
  prepare,
  run,
  seasonOf,
  spearman,
  windowReturn,
} from "../../web/lib/earnings-explore.ts";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// 200 trading "dates"; SPY flat unless given.
const DATES = Array.from({ length: 200 }, (_, i) => {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
});

function ev(dayIdx, path, extra = {}) {
  return { t: "X", d: DATES[dayIdx], s: "bmo", sec: "Tech", sur: 1, src: "backtest", p: path, ...extra };
}

test("seasonOf", () => {
  assert.equal(seasonOf("2024-03-31"), "2024Q1");
  assert.equal(seasonOf("2024-10-01"), "2024Q4");
});

test("window returns and cumulative path line up with day offsets", () => {
  const p = Array(61).fill(0);
  p[PATH_DAYS - 1] = 1000; // day -1: +1%
  p[PATH_DAYS] = 2000; // day 0: +2%
  const [e] = prepare([ev(100, p)], DATES, DATES.map(() => 0));
  close(windowReturn(e.stock, -1, -1), 0.01);
  close(windowReturn(e.stock, -2, 0), 1.01 * 1.02 - 1);
  close(e.stockCum[PATH_DAYS - 1], 0); // base: day -1 close
  close(e.stockCum[PATH_DAYS], 0.02);
  close(e.stockCum[PATH_DAYS - 2], 1 / 1.01 - 1); // day -2 close sat 1% below day -1
});

test("missing day → NaN window; SPY path follows the event's own dates", () => {
  const p = Array(61).fill(0);
  p[PATH_DAYS + 3] = null;
  const spy = DATES.map((_, i) => (i === 101 ? 0.005 : 0));
  const [e] = prepare([ev(100, p)], DATES, spy);
  assert.ok(Number.isNaN(windowReturn(e.stock, 0, 5)));
  close(windowReturn(e.spy, 1, 1), 0.005);
  assert.equal(prepare([ev(100, p, { d: "1999-01-01" })], DATES, spy).length, 0);
});

test("run: reversal shows as a negative top-minus-bottom spread, with halves", () => {
  // 3 seasons (Q1, Q2, Q3 of 2024) × 30 events; before-move x, reaction −0.5·x.
  const events = [];
  for (const start of [40, 95, 185]) {
    for (let i = 0; i < 30; i++) {
      const x = (i - 15) / 1000; // day -1 return
      const p = Array(61).fill(0);
      p[PATH_DAYS - 1] = Math.round(x * 100_000);
      p[PATH_DAYS] = Math.round(-0.5 * x * 100_000);
      events.push(ev(start + (i % 10), p));
    }
  }
  const spy = DATES.map(() => 0);
  const r = run(prepare(events, DATES, spy), { ...DEFAULT_SETTINGS, pre: [-1, -1], post: [0, 0] });
  assert.equal(r.events, 90);
  assert.equal(r.groups.length, 5);
  assert.ok(r.groups[0].y > r.groups[4].y);
  assert.equal(r.all.seasons, 3);
  assert.equal(r.all.positive, 0);
  assert.ok(r.all.mean < 0);
  assert.equal(r.early.seasons + r.late.seasons, 3);
  assert.ok(r.spearman < -0.99);
  assert.equal(r.sameSign, 0);
  // average path: everyone is 0 at day -1
  const d1 = r.path.find((q) => q.day === -1);
  close(d1.all, 0);
});

test("run filters: session, surprise, sector, cohort", () => {
  const p = Array(61).fill(0);
  const events = [
    ev(100, p, { s: "amc" }),
    ev(100, p, { s: "bmo", sur: -2 }),
    ev(100, p, { sec: "Energy" }),
    ev(100, p, { src: "live" }),
    ev(100, p, { sur: null }),
  ];
  const prep = prepare(events, DATES, DATES.map(() => 0));
  const n = (o) => run(prep, { ...DEFAULT_SETTINGS, ...o }).events;
  assert.equal(n({}), 4);
  assert.equal(n({ cohort: "both" }), 5);
  assert.equal(n({ session: "after" }), 1);
  assert.equal(n({ session: "before" }), 3);
  assert.equal(n({ surprise: "miss" }), 1);
  assert.equal(n({ surprise: "beat" }), 2); // null surprise is neither
  assert.equal(n({ sector: "Energy" }), 1);
});

test("small seasons are not split into groups", () => {
  const p = Array(61).fill(0);
  const r = run(prepare([ev(100, p), ev(101, p)], DATES, DATES.map(() => 0)), DEFAULT_SETTINGS);
  assert.equal(r.groups.length, 0);
  assert.equal(r.all.seasons, 0);
});

test("meanT and spearman", () => {
  assert.deepEqual(meanT([]), { mean: null, t: null, seasons: 0, positive: 0 });
  const m = meanT([1, 2, 3]);
  close(m.mean, 2);
  close(m.t, 2 / (1 / Math.sqrt(3)));
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});

import { answer, patternsOf, DEFAULT_ANSWER } from "../../web/lib/earnings-explore.ts";

test("patternsOf: named shapes over a window of daily returns", () => {
  assert.deepEqual(patternsOf([0.01, 0.01, 0.01, -0.001]).sort(), ["up_days"]);
  assert.ok(patternsOf([-0.01, -0.01, -0.01]).includes("down_days"));
  assert.ok(patternsOf([0, 0, 0.04]).includes("jump_last"));
  assert.ok(patternsOf([0, 0, -0.04]).includes("drop_last"));
  assert.ok(patternsOf([-0.01, -0.01, 0.015, 0.015]).includes("dip_recover"));
  assert.ok(patternsOf([0.01, 0.01, -0.015, -0.015]).includes("rally_fade"));
  assert.ok(patternsOf([0.001, -0.002, 0.003]).includes("quiet"));
  assert.ok(!patternsOf([0.001, -0.025, 0.003]).includes("quiet")); // one day beyond ±2%
  assert.deepEqual(patternsOf([0.01, NaN]), []);
});

test("answer: 2×2 direction table, buckets, size correlation", () => {
  // Before-move up → after up; before down → after down, twice as big: perfect continuation.
  const events = [];
  for (let i = 0; i < 40; i++) {
    const x = (i % 2 ? 1 : -1) * (0.01 + i / 1000); // day -1 return
    const p = Array(61).fill(0);
    p[PATH_DAYS - 1] = Math.round(x * 100_000);
    p[PATH_DAYS] = Math.round(2 * x * 100_000);
    events.push(ev(60 + (i % 20), p));
  }
  const a = answer(prepare(events, DATES, DATES.map(() => 0)), { ...DEFAULT_ANSWER, pre: [-1, -1], post: [0, 0] });
  assert.equal(a.events, 40);
  assert.equal(a.beforeUp.events, 20);
  assert.equal(a.beforeUp.upShare, 1);
  assert.equal(a.beforeDown.upShare, 0);
  assert.equal(a.dirDiff, 1);
  close(a.corrDirection, 1);
  close(a.corrSize, 1);
  assert.equal(a.buckets.find((b) => b.key === "rose").events, 10); // +3%…+10%: i = 21, 23, …, 39
  assert.equal(a.points.length, 40);
  close(a.beforeUp.avgSize, a.beforeUp.avg);
});

import { contextKeys, volumeRatio } from "../../web/lib/earnings-explore.ts";

test("volumeRatio averages the stored before-days only", () => {
  const v = Array(30).fill(100);
  v[29] = 300; // day -1
  close(volumeRatio(v, -1, -1), 3);
  close(volumeRatio(v, -2, -1), 2);
  close(volumeRatio(v, -5, 3), (100 * 4 + 300) / 5 / 100); // days ≥ 0 aren't stored
  assert.equal(volumeRatio(null, -5, -1), null);
});

test("contextKeys and the 'only' filter", () => {
  const p = Array(61).fill(0);
  const v = Array(30).fill(250);
  const e1 = ev(100, p, { ib: 2, v, m50: 0.05, m200: -0.1, sur: 20 });
  const e2 = ev(100, p, { ib: 0, v: null, m50: null, m200: null, sur: -3 });
  assert.deepEqual(contextKeys(e1, [-10, -1]), ["ins_yes", "vol_vhigh", "ma50_above", "ma200_below", "eps_big"]);
  assert.deepEqual(contextKeys(e2, [-10, -1]), ["ins_no", "eps_miss"]);
  const prep = prepare([e1, e2], DATES, DATES.map(() => 0));
  assert.equal(answer(prep, { ...DEFAULT_ANSWER, only: "ins_yes" }).events, 1);
  const a = answer(prep, DEFAULT_ANSWER);
  assert.equal(a.context.find((c) => c.key === "eps_miss").events, 1);
  assert.equal(a.context.find((c) => c.key === "vol_low").events, 0);
});
