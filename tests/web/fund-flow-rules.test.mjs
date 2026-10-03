// Tests for web/lib/fund-flow-rules.ts — the /funds label, filters, sorting and rollup.
//   node --test --experimental-strip-types tests/web
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  label,
  parseParams,
  quarterCoverage,
  quarterName,
  rollup,
  sortQuery,
  sortRollup,
  sortRows,
  toQuery,
} from "../../web/lib/fund-flow-rules.ts";

function row(o) {
  return {
    ticker: "AAA", name: null, industry: "Semiconductors", sector: "Technology",
    market_cap_usd: 5e9, avg_dollar_volume_20d: 2e7, return_6mo: 0.1,
    buyers: 0, sellers: 0, net: 0, opened: 0, added: 0, trimmed: 0, exited: 0,
    tier_net: 0, sa_buyers: 0, conviction_max: null, conviction_max_filer: null, conviction_sum: null,
    streak: 0, min_period: "2026-06-30", max_period: "2026-06-30",
    insider_buyers: 0, insider_names: [], activist_filers: [], activist_latest: null,
    funds: [], computed_at: null, ...o,
  };
}

test("label boundaries follow the printed rule", () => {
  const cases = [
    [{ net: 3, sa_buyers: 1, streak: 2 }, "Strong"],
    [{ net: 9, sa_buyers: 2, streak: 5 }, "Strong"],
    [{ net: 3, sa_buyers: 1, streak: 1 }, "Moderate"], // streak too short
    [{ net: 5, sa_buyers: 0, streak: 3 }, "Moderate"], // no S/A-tier buyer
    [{ net: 9, sa_buyers: 0, streak: 0 }, "Moderate"],
    [{ net: 3, sa_buyers: 0, streak: 0 }, "Moderate"],
    [{ net: 2, sa_buyers: 2, streak: 4 }, "Weak"],     // below the net bar even with everything else
    [{ net: 1, sa_buyers: 0, streak: 0 }, "Weak"],
    [{ net: 0, sa_buyers: 0, streak: 0 }, null],
    [{ net: -1, sa_buyers: 0, streak: 0 }, null],
    [{ net: -2, sa_buyers: 0, streak: 0 }, "Net selling"],
  ];
  for (const [input, expected] of cases) assert.equal(label(input), expected, JSON.stringify(input));
});

test("parseParams: defaults, valid values and garbage", () => {
  const d = parseParams({});
  assert.equal(d.view, "industries");
  assert.equal(d.sort, "total_net");
  assert.equal(d.dir, "desc");
  assert.equal(d.lag, 1);
  assert.equal(d.tiers, null);

  const f = parseParams({ industry: "Semiconductors", tier: "S,A,S,Z", style: "activist,nope", quarters: "2",
    min_net: "3", cap_min: "300", ret6_max: "60", label: "Strong", watch: "1", sort: "net", dir: "asc" });
  assert.equal(f.view, "stocks");
  assert.deepEqual(f.tiers, ["S", "A"]);
  assert.deepEqual(f.categories, ["activist"]);
  assert.deepEqual([f.lag, f.minNet, f.capMinM, f.ret6MaxPct, f.label, f.watchlist, f.sort, f.dir],
    [2, 3, 300, 60, "Strong", true, "net", "asc"]);

  const g = parseParams({ min_net: "abc", tier: "Z", quarters: "7", sort: "bogus", dir: "sideways", label: "Great", cap_min: "" });
  assert.deepEqual([g.minNet, g.tiers, g.lag, g.sort, g.dir, g.label, g.capMinM], [null, null, 1, "total_net", "desc", null, null]);
  assert.equal(parseParams({ view: "stocks", sort: "total_net" }).sort, "label"); // rollup sort isn't a stock sort
});

test("6-month return can only sort ascending (§2.2: no momentum ranking)", () => {
  const f = parseParams({ view: "stocks", sort: "return_6m", dir: "desc" });
  assert.equal(f.dir, "asc");
  assert.match(sortQuery(f, "return_6m"), /dir=asc/);
});

test("toQuery keeps non-defaults and round-trips through parseParams", () => {
  const f = parseParams({ industry: "Biotechnology", tier: "S,A", min_net: "2", sort: "streak", dir: "desc" });
  const q = toQuery(f);
  const back = parseParams(Object.fromEntries(new URLSearchParams(q.slice(1))));
  assert.deepEqual(back, f);
  assert.equal(toQuery(parseParams({})), "");
  assert.equal(toQuery(f, { industry: null, view: "stocks" }).includes("industry"), false);
});

test("sortQuery flips the active column and starts a new one at its default", () => {
  const f = parseParams({ view: "stocks", sort: "net", dir: "desc" });
  assert.match(sortQuery(f, "net"), /sort=net&dir=asc/);
  assert.match(sortQuery(f, "market_cap"), /sort=market_cap&dir=asc/);
  assert.match(sortQuery(f, "streak"), /sort=streak&dir=desc/);
});

test("applyFilters: industry, numbers (unknowns fail), label and watchlist", () => {
  const rows = [
    row({ ticker: "AAA", net: 6, sa_buyers: 1, streak: 2 }),
    row({ ticker: "BBB", industry: null, net: 2, market_cap_usd: null }),
    row({ ticker: "CCC", net: -3, return_6mo: 0.9, market_cap_usd: 2e8 }),
  ];
  const t = (p, w) => applyFilters(rows, parseParams(p), w).map((r) => r.ticker);
  assert.deepEqual(t({ industry: "Unclassified" }), ["BBB"]);
  assert.deepEqual(t({ cap_min: "300" }), ["AAA"]); // BBB unknown cap fails; CCC $200M fails
  assert.deepEqual(t({ ret6_max: "60" }), ["AAA", "BBB"]);
  assert.deepEqual(t({ min_net: "2" }), ["AAA", "BBB"]);
  assert.deepEqual(t({ label: "Net selling" }), ["CCC"]);
  assert.deepEqual(t({ label: "none" }), []);
  assert.deepEqual(t({ watch: "1" }, new Set(["CCC"])), ["CCC"]);
});

test("sortRows: empty values last both ways; label ties broken by conviction Σ then ticker", () => {
  const rows = [
    row({ ticker: "B", net: 5, sa_buyers: 1, streak: 2, conviction_sum: 0.01 }),
    row({ ticker: "A", net: 6, sa_buyers: 1, streak: 3, conviction_sum: 0.05 }),
    row({ ticker: "C", net: 1, conviction_sum: null }),
    row({ ticker: "D", net: -4, conviction_sum: 0.2 }),
    row({ ticker: "E", net: 0, conviction_sum: 0.2 }),
  ];
  const t = (k, d) => sortRows(rows, k, d).map((r) => r.ticker);
  assert.deepEqual(t("label", "desc"), ["A", "B", "C", "E", "D"]);
  assert.deepEqual(t("conviction_sum", "desc"), ["D", "E", "A", "B", "C"]);
  assert.deepEqual(t("conviction_sum", "asc"), ["B", "A", "D", "E", "C"]);
  assert.deepEqual(t("net", "asc"), ["D", "E", "C", "B", "A"]);
});

test("rollup groups by industry, puts blanks in Unclassified, and counts net-bought/sold", () => {
  const rows = [
    row({ ticker: "A", industry: "Semis", net: 3 }),
    row({ ticker: "B", industry: "Semis", net: -2 }),
    row({ ticker: "C", industry: "Semis", net: 6, sa_buyers: 1, streak: 2 }),
    row({ ticker: "D", industry: null, sector: null, net: 1 }),
  ];
  const r = Object.fromEntries(rollup(rows).map((x) => [x.industry, x]));
  assert.deepEqual([r.Semis.stocks, r.Semis.netBought, r.Semis.netSold, r.Semis.totalNet], [3, 2, 1, 7]);
  assert.deepEqual(r.Semis.top, ["C", "A"]); // net-bought only, default stock order
  assert.equal(r.Unclassified.stocks, 1);
  const sorted = sortRollup(rollup(rows), "total_net", "desc").map((x) => x.industry);
  assert.deepEqual(sorted, ["Semis", "Unclassified"]);
  assert.deepEqual(sortRollup(rollup(rows), "industry", "asc").map((x) => x.industry), ["Semis", "Unclassified"]);
});

test("quarter helpers name quarters and count funds per newest filing", () => {
  assert.equal(quarterName("2026-06-30"), "Q2 2026");
  assert.equal(quarterName("2026-09-30T00:00:00"), "Q3 2026");
  const rows = [
    row({ funds: [{ cik: "1", period: "2026-09-30" }, { cik: "2", period: "2026-06-30" }] }),
    row({ funds: [{ cik: "1", period: "2026-09-30" }, { cik: "3", period: "2026-06-30" }] }),
  ];
  assert.deepEqual(quarterCoverage(rows), [{ period: "2026-09-30", funds: 1 }, { period: "2026-06-30", funds: 2 }]);
});
