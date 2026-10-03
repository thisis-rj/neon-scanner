// Tests for fund_flows() and its tables (migration 025) — the /funds page's
// only counting code. Runs the real migration SQL in PGlite.
//   cd tests/sql && npm ci && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(new URL("../../schema/migrations/025_fund_flows.sql", import.meta.url), "utf8");

// tickers as it exists before 025 (schema/supabase.sql), plus the roles
// Supabase provides that the migration's grant names.
const BASE_SCHEMA = `
create role anon; create role authenticated; create role service_role;
create table tickers (
  ticker text primary key, name text, market_cap_usd numeric, avg_dollar_volume_20d numeric,
  price numeric, return_3mo numeric, return_6mo numeric, return_12mo numeric,
  classification text, snapshot_at timestamptz not null default now()
);`;

async function db() {
  const pg = new PGlite();
  await pg.exec(BASE_SCHEMA);
  await pg.exec(MIGRATION);
  return pg;
}

const TIER_MULT = { S: 1.5, A: 1.2, B: 1.0, C: 0.7 };

// change(pg, { cik, t, ev, tier, rank, lag, pct, period, cat })
async function change(pg, c) {
  const tier = c.tier ?? "B";
  const rank = c.rank ?? 0;
  await pg.query(
    `insert into fund_position_changes
       (cik, ticker, lag_quarters, pair_rank, period, prev_period, event, shares_prev, shares_cur,
        value_usd, pct_of_fund, issuer_name, filer_name, tier, category, tier_mult, run_id)
     values ($1, $2, $3, $4, $5, $6, $7, 100, 200, 1000, $8, $9, $10, $11, $12, $13, 'r1')`,
    [c.cik, c.t, c.lag ?? 1, rank, c.period ?? "2026-06-30", c.prev ?? "2026-03-31", c.ev, c.pct ?? null,
     c.issuer ?? `${c.t} ISSUER`, `Fund ${c.cik}`, tier, c.cat ?? "value", TIER_MULT[tier]],
  );
}

async function flows(pg, lag = 1, tiers = null, cats = null) {
  const r = await pg.query(`select * from fund_flows($1, $2, $3) order by ticker`, [lag, tiers, cats]);
  return Object.fromEntries(r.rows.map((x) => [x.ticker, x]));
}

test("counts buyers, sellers, net, each event, tier-weighted net and S/A buyers", async () => {
  const pg = await db();
  await change(pg, { cik: "1", t: "AAA", ev: "opened", tier: "S", pct: 0.05 });
  await change(pg, { cik: "2", t: "AAA", ev: "added", tier: "A", pct: 0.02 });
  await change(pg, { cik: "3", t: "AAA", ev: "added", tier: "B", pct: 0.01 });
  await change(pg, { cik: "4", t: "AAA", ev: "trimmed", tier: "C", pct: 0.03 });
  await change(pg, { cik: "5", t: "AAA", ev: "exited", tier: "B", pct: 0.04 });
  const r = (await flows(pg)).AAA;
  assert.deepEqual(
    [r.buyers, r.sellers, r.net, r.opened, r.added, r.trimmed, r.exited, r.sa_buyers],
    [3, 2, 1, 1, 2, 1, 1, 2],
  );
  assert.equal(Number(r.tier_net), 1.5 + 1.2 + 1.0 - 0.7 - 1.0);
});

test("conviction uses buyers only: biggest bet, whose it is, and the sum", async () => {
  const pg = await db();
  await change(pg, { cik: "1", t: "AAA", ev: "opened", pct: 0.05 });
  await change(pg, { cik: "2", t: "AAA", ev: "added", pct: 0.02 });
  await change(pg, { cik: "3", t: "AAA", ev: "exited", pct: 0.4 }); // a seller's big exit is not conviction
  await change(pg, { cik: "4", t: "BBB", ev: "trimmed", pct: 0.1 });
  const f = await flows(pg);
  assert.equal(Number(f.AAA.conviction_max), 0.05);
  assert.equal(f.AAA.conviction_max_filer, "Fund 1");
  assert.ok(Math.abs(Number(f.AAA.conviction_sum) - 0.07) < 1e-12);
  assert.equal(f.BBB.conviction_max, null);
  assert.equal(f.BBB.conviction_sum, null);
});

test("streak counts consecutive net-buying quarters from the newest, and stops at a gap", async () => {
  const pg = await db();
  // AAA: rank 0 +1, rank 1 +1, rank 2 −1, rank 3 +1 → streak 2
  await change(pg, { cik: "1", t: "AAA", ev: "added", rank: 0 });
  await change(pg, { cik: "1", t: "AAA", ev: "added", rank: 1 });
  await change(pg, { cik: "1", t: "AAA", ev: "trimmed", rank: 2 });
  await change(pg, { cik: "1", t: "AAA", ev: "added", rank: 3 });
  // BBB: newest quarter net selling → 0
  await change(pg, { cik: "1", t: "BBB", ev: "exited", rank: 0 });
  await change(pg, { cik: "2", t: "BBB", ev: "added", rank: 1 });
  // CCC: rank 0 positive, nothing at rank 1, rank 2 positive → 1
  await change(pg, { cik: "1", t: "CCC", ev: "opened", rank: 0 });
  await change(pg, { cik: "1", t: "CCC", ev: "added", rank: 2 });
  // DDD: 1 buyer vs 1 seller in the newest quarter is net 0 → 0
  await change(pg, { cik: "1", t: "DDD", ev: "added", rank: 0 });
  await change(pg, { cik: "2", t: "DDD", ev: "trimmed", rank: 0 });
  const f = await flows(pg);
  assert.deepEqual([f.AAA.streak, f.BBB.streak, f.CCC.streak, f.DDD.streak], [2, 0, 1, 0]);
});

test("older pairs feed the streak but not the latest counts", async () => {
  const pg = await db();
  await change(pg, { cik: "1", t: "AAA", ev: "added", rank: 0 });
  await change(pg, { cik: "2", t: "AAA", ev: "opened", rank: 1 });
  const r = (await flows(pg)).AAA;
  assert.deepEqual([r.buyers, r.net, r.streak], [1, 1, 2]);
  assert.equal(r.funds.length, 1);
});

test("lag 2 counts the two-quarter comparison; the streak stays quarter to quarter", async () => {
  const pg = await db();
  await change(pg, { cik: "1", t: "AAA", ev: "trimmed", rank: 0, lag: 1 });
  await change(pg, { cik: "1", t: "AAA", ev: "added", rank: 0, lag: 2, prev: "2025-12-31" });
  const l1 = (await flows(pg, 1)).AAA;
  const l2 = (await flows(pg, 2)).AAA;
  assert.deepEqual([l1.net, l1.streak], [-1, 0]);
  assert.deepEqual([l2.net, l2.buyers, l2.streak], [1, 1, 0]);
});

test("tier and category filters recount everything, including the streak", async () => {
  const pg = await db();
  await change(pg, { cik: "1", t: "AAA", ev: "added", tier: "S", cat: "value", rank: 0 });
  await change(pg, { cik: "2", t: "AAA", ev: "trimmed", tier: "C", cat: "activist", rank: 0 });
  await change(pg, { cik: "3", t: "AAA", ev: "exited", tier: "B", cat: "growth", rank: 0 });
  await change(pg, { cik: "1", t: "AAA", ev: "added", tier: "S", cat: "value", rank: 1 });
  await change(pg, { cik: "4", t: "BBB", ev: "opened", tier: "C", cat: "activist", rank: 0 });
  const all = await flows(pg);
  assert.deepEqual([all.AAA.net, all.AAA.streak], [-1, 0]);
  const sa = await flows(pg, 1, ["S", "A"]);
  assert.deepEqual([sa.AAA.net, sa.AAA.sellers, sa.AAA.streak], [1, 0, 2]);
  assert.equal(sa.BBB, undefined); // only a C-tier fund touched it
  const act = await flows(pg, 1, null, ["activist"]);
  assert.deepEqual(Object.keys(act), ["AAA", "BBB"]);
  assert.equal(act.AAA.net, -1);
});

test("joins name, industry and price facts from tickers; falls back to the 13F issuer name", async () => {
  const pg = await db();
  await pg.query(
    `insert into tickers (ticker, name, market_cap_usd, avg_dollar_volume_20d, return_6mo, industry, sector)
     values ('AAA', 'Alpha Corp', 5e9, 2e7, 0.12, 'Semiconductors', 'Technology')`,
  );
  await change(pg, { cik: "1", t: "AAA", ev: "opened" });
  await change(pg, { cik: "1", t: "ZZZ", ev: "opened", issuer: "ZED HOLDINGS ORD" });
  const f = await flows(pg);
  assert.equal(f.AAA.name, "Alpha Corp");
  assert.equal(f.AAA.industry, "Semiconductors");
  assert.equal(Number(f.AAA.market_cap_usd), 5e9);
  assert.equal(Number(f.AAA.return_6mo), 0.12);
  assert.equal(f.ZZZ.name, "ZED HOLDINGS ORD");
  assert.equal(f.ZZZ.industry, null);
});

test("insider and activist columns come from stock_signal_extras; defaults when absent", async () => {
  const pg = await db();
  await pg.query(
    `insert into stock_signal_extras (ticker, insider_buyers, insider_names, activist_filers, activist_latest, run_id)
     values ('AAA', 3, '{Ann,Bob,Cy}', '{Elliott}', '2026-09-01', 'r1')`,
  );
  await change(pg, { cik: "1", t: "AAA", ev: "opened" });
  await change(pg, { cik: "1", t: "BBB", ev: "opened" });
  const f = await flows(pg);
  assert.equal(f.AAA.insider_buyers, 3);
  assert.deepEqual(f.AAA.activist_filers, ["Elliott"]);
  assert.equal(f.BBB.insider_buyers, 0);
  assert.deepEqual(f.BBB.insider_names, []);
});

test("reports the range of fund quarters behind the count", async () => {
  const pg = await db();
  await change(pg, { cik: "1", t: "AAA", ev: "opened", period: "2026-09-30", prev: "2026-06-30" });
  await change(pg, { cik: "2", t: "AAA", ev: "added", period: "2026-06-30" });
  const r = (await flows(pg)).AAA;
  assert.equal(r.min_period.toISOString().slice(0, 10), "2026-06-30");
  assert.equal(r.max_period.toISOString().slice(0, 10), "2026-09-30");
});

test("empty table returns no rows", async () => {
  const pg = await db();
  assert.deepEqual(await flows(pg), {});
});

test("rejects an unknown event and a lag other than 1 or 2", async () => {
  const pg = await db();
  await assert.rejects(change(pg, { cik: "1", t: "AAA", ev: "held" }));
  await assert.rejects(change(pg, { cik: "1", t: "AAA", ev: "added", lag: 3 }));
});
