// Tests for the holdings_13f_effective rule (migration 023, now holdings_13f_effective_live),
// its stored copy and refresh (migration 025), and the holdings_recent() RPC.
//
// Runs the real migration SQL in PGlite (Postgres compiled to WASM), so the
// view's replace/union rules are checked without touching Supabase.
//   cd tests/sql && npm ci && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(new URL("../../schema/migrations/023_holdings_effective.sql", import.meta.url), "utf8");
const MATERIALIZE = readFileSync(new URL("../../schema/migrations/025_holdings_effective_materialized.sql", import.meta.url), "utf8");
const FAST_RECENT = readFileSync(new URL("../../schema/migrations/026_holdings_recent_fast.sql", import.meta.url), "utf8");

// Minimal copies of the two tables as they exist before 023 (schema/supabase.sql).
const BASE_SCHEMA = `
create table filings_raw (
  id text primary key, accession_number text unique not null, cik text not null,
  filer_name text, form_type text not null, filed_at timestamptz not null, period_of_report date
);
create table holdings_13f (
  id serial primary key, filing_id text not null references filings_raw(id) on delete cascade,
  cik text not null, period_of_report date not null, cusip text, ticker text, issuer_name text,
  shares bigint, value_usd numeric, put_call text
);
create role anon; create role authenticated; create role service_role;`;

async function db({ materialize = true } = {}) {
  const pg = new PGlite();
  await pg.exec(BASE_SCHEMA);
  await pg.exec(MIGRATION);
  if (materialize) {
    await pg.exec(MATERIALIZE);
    await pg.exec(FAST_RECENT);
  }
  return pg;
}

let acc = 0;
async function filing(pg, { id, cik = "1", period = "2026-06-30", filed, form = "13F-HR", amendment = null }) {
  await pg.query(
    `insert into filings_raw (id, accession_number, cik, filer_name, form_type, filed_at, period_of_report, amendment_type)
     values ($1, $2, $3, 'Fund ' || $3, $4, $5, $6, $7)`,
    [id, `0000000000-26-${String(++acc).padStart(6, "0")}`, cik, form, filed, period, amendment],
  );
}
async function rows(pg, filingId, list) {
  const f = (await pg.query(`select cik, period_of_report from filings_raw where id = $1`, [filingId])).rows[0];
  for (const r of list) {
    await pg.query(
      `insert into holdings_13f (filing_id, cik, period_of_report, cusip, ticker, shares, put_call, sh_type)
       values ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [filingId, f.cik, f.period_of_report, r.t, r.sh ?? 100, r.pc ?? null, r.type === undefined ? "SH" : r.type],
    );
  }
}
async function effective(pg, cik = "1", period = "2026-06-30") {
  const r = await pg.query(
    `select filing_id, ticker, shares from holdings_13f_effective_live where cik = $1 and period_of_report = $2 order by ticker, filing_id, shares`,
    [cik, period],
  );
  return r.rows.map((x) => `${x.ticker}@${x.filing_id}:${x.shares}`);
}

test("plain quarter keeps share rows, drops put/call and PRN, keeps pre-reparse NULL sh_type", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-14" });
  await rows(pg, "o", [
    { t: "AAA" }, { t: "BBB", type: null }, { t: "CCC", pc: "Put" }, { t: "DDD", pc: "Call" }, { t: "EEE", type: "PRN" },
  ]);
  assert.deepEqual(await effective(pg), ["AAA@o:100", "BBB@o:100"]);
});

test("RESTATEMENT replaces the original", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-14" });
  await rows(pg, "o", [{ t: "AAA" }, { t: "BBB" }]);
  await filing(pg, { id: "r", filed: "2026-08-20", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "r", [{ t: "AAA", sh: 150 }, { t: "CCC" }]);
  assert.deepEqual(await effective(pg), ["AAA@r:150", "CCC@r:100"]);
});

test("two restatements (the Oaktree case): only the latest counts, once", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-05-15", period: "2026-03-31" });
  await rows(pg, "o", [{ t: "TRMD" }]);
  await filing(pg, { id: "r1", filed: "2026-05-20", period: "2026-03-31", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "r1", [{ t: "TRMD" }]);
  await filing(pg, { id: "r2", filed: "2026-05-22", period: "2026-03-31", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "r2", [{ t: "TRMD" }]);
  assert.deepEqual(await effective(pg, "1", "2026-03-31"), ["TRMD@r2:100"]);
});

test("NEW HOLDINGS adds to the original (the Berkshire case)", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2025-05-15", period: "2025-03-31" });
  await rows(pg, "o", [{ t: "AAPL" }, { t: "KO" }]);
  await filing(pg, { id: "n", filed: "2025-08-14", period: "2025-03-31", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "SECRET" }]);
  assert.deepEqual(await effective(pg, "1", "2025-03-31"), ["AAPL@o:100", "KO@o:100", "SECRET@n:100"]);
});

test("NEW HOLDINGS that re-lists the whole original (the First Eagle case) adds only the genuinely new rows", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "NOV", sh: 836350 }, { t: "NOV", sh: 29848341 }, { t: "WCC", sh: 52748 }]);
  await filing(pg, { id: "n", filed: "2026-08-24", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "NOV", sh: 836350 }, { t: "NOV", sh: 29848341 }, { t: "WCC", sh: 52748 }, { t: "NEW1", sh: 10 }]);
  assert.deepEqual(await effective(pg), ["NEW1@n:10", "NOV@o:836350", "NOV@o:29848341", "WCC@o:52748"]);
});

test("a NEW HOLDINGS row with the same security but a different share count is kept", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "AAA", sh: 100 }]);
  await filing(pg, { id: "n", filed: "2026-08-24", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "AAA", sh: 40 }]);
  assert.deepEqual(await effective(pg), ["AAA@n:40", "AAA@o:100"]);
});

test("NEW HOLDINGS filed before a later RESTATEMENT is superseded by it", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2023-11-14", period: "2023-09-30" });
  await rows(pg, "o", [{ t: "AAA" }]);
  await filing(pg, { id: "n", filed: "2024-02-14", period: "2023-09-30", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "BBB" }]);
  await filing(pg, { id: "r", filed: "2024-05-15", period: "2023-09-30", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "r", [{ t: "AAA" }, { t: "BBB" }]);
  assert.deepEqual(await effective(pg, "1", "2023-09-30"), ["AAA@r:100", "BBB@r:100"]);
});

test("NEW HOLDINGS filed after a RESTATEMENT unions with the restatement", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-01" });
  await rows(pg, "o", [{ t: "AAA" }]);
  await filing(pg, { id: "r", filed: "2026-08-10", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "r", [{ t: "AAA", sh: 90 }]);
  await filing(pg, { id: "n", filed: "2026-08-20", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "BBB" }]);
  assert.deepEqual(await effective(pg), ["AAA@r:90", "BBB@n:100"]);
});

test("amendment with unknown type (NULL) is treated as RESTATEMENT", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-14" });
  await rows(pg, "o", [{ t: "AAA" }]);
  await filing(pg, { id: "a", filed: "2026-08-20", form: "13F-HR/A", amendment: null });
  await rows(pg, "a", [{ t: "BBB" }]);
  assert.deepEqual(await effective(pg), ["BBB@a:100"]);
});

test("a restatement with no parsed rows never wipes out the quarter", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-14" });
  await rows(pg, "o", [{ t: "AAA" }]);
  await filing(pg, { id: "r", filed: "2026-08-20", form: "13F-HR/A", amendment: "RESTATEMENT" });
  assert.deepEqual(await effective(pg), ["AAA@o:100"]);
});

test("NEW HOLDINGS with no original on file still shows", async () => {
  const pg = await db();
  await filing(pg, { id: "n", filed: "2026-08-20", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "AAA" }]);
  assert.deepEqual(await effective(pg), ["AAA@n:100"]);
});

test("filers and quarters don't bleed into each other", async () => {
  const pg = await db();
  await filing(pg, { id: "a1", cik: "1", filed: "2026-08-14" });
  await rows(pg, "a1", [{ t: "AAA" }]);
  await filing(pg, { id: "b1", cik: "2", filed: "2026-08-20", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "b1", [{ t: "BBB" }]);
  await filing(pg, { id: "a0", cik: "1", period: "2026-03-31", filed: "2026-05-15" });
  await rows(pg, "a0", [{ t: "OLD" }]);
  assert.deepEqual(await effective(pg, "1"), ["AAA@a1:100"]);
  assert.deepEqual(await effective(pg, "2"), ["BBB@b1:100"]);
  assert.deepEqual(await effective(pg, "1", "2026-03-31"), ["OLD@a0:100"]);
});

test("holdings_recent() returns the 2 latest periods per filer from the view", async () => {
  const pg = await db();
  for (const [id, period, filed] of [["q1", "2026-03-31", "2026-05-15"], ["q2", "2026-06-30", "2026-08-14"], ["q0", "2025-12-31", "2026-02-14"]]) {
    await filing(pg, { id, period, filed });
    await rows(pg, id, [{ t: "AAA" }, { t: "HEDGE", pc: "Put" }]);
  }
  await filing(pg, { id: "n", period: "2026-06-30", filed: "2026-08-30", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "SECRET" }]);
  await pg.exec("select refresh_holdings_effective()");
  const r = await pg.query(`select period_of_report::text as p, ticker, put_call, filer_name from holdings_recent(2) order by p, ticker`);
  assert.deepEqual(
    r.rows.map((x) => `${x.p} ${x.ticker} ${x.put_call}`),
    ["2026-03-31 AAA null", "2026-06-30 AAA null", "2026-06-30 SECRET null"],
  );
  assert.equal(r.rows[0].filer_name, "Fund 1");
});

test("023 is re-runnable on its own, and 025 is re-runnable", async () => {
  const plain = await db({ materialize: false });
  await plain.exec(MIGRATION);
  const pg = await db();
  await pg.exec(MATERIALIZE);
  await pg.exec(FAST_RECENT);
});

// Value: protects=holdings_recent() returns exactly the rows and order of the straightforward "rank every holding" query; fails_when=the distinct-periods rewrite drops a period, mis-ranks ties, or changes the page order; why_new=the other holdings_recent test has one filer and checks a sorted copy; seam=none
test("holdings_recent() matches the rank-every-row reference, rows and order", async () => {
  const pg = await db();
  const periods = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
  for (const cik of ["1", "2", "3"]) {
    for (const [i, period] of periods.entries()) {
      if (cik === "3" && i === 3) continue;           // filer 3 is a quarter behind
      const id = `f${cik}-${i}`;
      await filing(pg, { id, cik, period, filed: `2026-0${i + 1}-15` });
      await rows(pg, id, [{ t: "AAA", sh: 1 + i }, { t: "BBB", sh: 10 + i }, { t: "OPT", pc: "Call" }]);
    }
  }
  await pg.exec("select refresh_holdings_effective()");
  for (const n of [1, 2, 3]) {
    const got = (await pg.query(`select cik, period_of_report::text p, ticker, shares from holdings_recent(${n})`)).rows;
    const want = (await pg.query(`
      with r as (select h.*, dense_rank() over (partition by h.cik order by h.period_of_report desc) rnk
                 from holdings_13f_effective h)
      select cik, period_of_report::text p, ticker, shares from r where rnk <= ${n}
      order by cik, period_of_report desc, id`)).rows;
    assert.deepEqual(got, want, `max_periods=${n}`);
  }
});

// Value: protects=readers see the stored copy, which equals the live rule after refresh_holdings_effective() and not before; fails_when=the refresh function breaks (e.g. CONCURRENTLY without the unique index) or readers bypass the stored copy; why_new=all other tests read the live rule; seam=none
test("stored copy matches the live rule after refresh, and only after", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "AAA" }, { t: "HEDGE", pc: "Put" }]);
  const stored = async () => (await pg.query(
    "select ticker from holdings_13f_effective order by ticker")).rows.map((x) => x.ticker);
  assert.deepEqual(await stored(), []);          // not refreshed yet
  await pg.exec("select refresh_holdings_effective()");
  assert.deepEqual(await stored(), ["AAA"]);
  await filing(pg, { id: "r", filed: "2026-09-01", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "r", [{ t: "BBB" }]);
  await pg.exec("select refresh_holdings_effective()");  // concurrent refresh over existing rows
  assert.deepEqual(await stored(), ["BBB"]);
});

// Value: protects=a same-day 13F-HR/A RESTATEMENT replaces its original (filed_at is date-only, ids are random UUIDs); fails_when=base tie-break on filed_at falls to id order and picks the original; why_new=all existing restatement cases file the amendment on a later day; seam=none
test("RESTATEMENT filed the same day as the original still replaces it, whatever the ids", async () => {
  const pg = await db();
  // filings_raw.filed_at is written as <date>T00:00:00Z and ids are gen_random_uuid(),
  // so a same-day correction ties on filed_at; give the original the higher id.
  await filing(pg, { id: "zz-original", filed: "2026-08-14" });
  await rows(pg, "zz-original", [{ t: "AAA", sh: 100 }, { t: "WRONG" }]);
  await filing(pg, { id: "aa-restated", filed: "2026-08-14", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "aa-restated", [{ t: "AAA", sh: 150 }]);
  assert.deepEqual(await effective(pg), ["AAA@aa-restated:150"]);
});

// Value: protects=two same-day RESTATEMENTs resolve to the later-filed one (higher accession number); fails_when=the tie-break drops accession_number and falls back to random ids; why_new=the test above only ties an original against one restatement; seam=none
test("two RESTATEMENTs on the same day: the later accession number wins, whatever the ids", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-14" });
  await rows(pg, "o", [{ t: "AAA", sh: 100 }]);
  await filing(pg, { id: "zz-first", filed: "2026-09-01", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "zz-first", [{ t: "AAA", sh: 120 }]);
  await filing(pg, { id: "aa-second", filed: "2026-09-01", form: "13F-HR/A", amendment: "RESTATEMENT" });
  await rows(pg, "aa-second", [{ t: "AAA", sh: 130 }]);
  assert.deepEqual(await effective(pg), ["AAA@aa-second:130"]);
});

// Value: protects=a NEW HOLDINGS amendment filed the same day as its original still adds its positions; fails_when=the view goes back to a strict filed_at > base comparison on a date-only column; why_new=existing NEW HOLDINGS cases are all filed on a later day; seam=none
test("NEW HOLDINGS filed the same day as the original still adds its new positions (copies still dropped)", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-14" });
  await rows(pg, "o", [{ t: "AAA", sh: 100 }]);
  await filing(pg, { id: "nh", filed: "2026-08-14", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "nh", [{ t: "AAA", sh: 100 }, { t: "BBB", sh: 50 }]);
  assert.deepEqual(await effective(pg), ["AAA@o:100", "BBB@nh:50"]);
});

// Value: protects=a second NEW HOLDINGS amendment that re-lists the first one's rows adds only its new positions; fails_when=the copy check compares only against the base filing; why_new=existing NEW HOLDINGS cases have a single amendment per quarter; seam=none
test("second NEW HOLDINGS that re-lists the first one's rows doesn't double-count", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "AAA", sh: 100 }]);
  await filing(pg, { id: "n1", filed: "2026-08-20", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n1", [{ t: "SECRET", sh: 10 }]);
  await filing(pg, { id: "n2", filed: "2026-09-01", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n2", [{ t: "AAA", sh: 100 }, { t: "SECRET", sh: 10 }, { t: "NEW2", sh: 5 }]);
  assert.deepEqual(await effective(pg), ["AAA@o:100", "NEW2@n2:5", "SECRET@n1:10"]);
});

// Value: protects=a mislabelled full re-list ("NEW HOLDINGS" repeating >= half the base, >= 5 securities) replaces the quarter, so a corrected share count isn't added on top; fails_when=re-lists go back to being unioned with the base; why_new=the First Eagle test has only 2 securities and exact copies; seam=none
test("NEW HOLDINGS that re-lists most of the base with a changed share count replaces the quarter", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "A1" }, { t: "A2" }, { t: "A3" }, { t: "A4" }, { t: "A5", sh: 100 }, { t: "A6" }]);
  await filing(pg, { id: "n", filed: "2026-08-24", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "A1" }, { t: "A2" }, { t: "A3" }, { t: "A4" }, { t: "A5", sh: 150 }, { t: "A6" }, { t: "NEW1", sh: 7 }]);
  assert.deepEqual(await effective(pg), [
    "A1@n:100", "A2@n:100", "A3@n:100", "A4@n:100", "A5@n:150", "A6@n:100", "NEW1@n:7"]);
});

// Value: protects=a true NEW HOLDINGS amendment (confidential positions, shares <= 1 base security) still adds to a large base; fails_when=the re-list threshold is loosened so additive amendments replace the quarter (Berkshire 114 -> 4); why_new=the Berkshire test base has only 2 rows; seam=none
test("NEW HOLDINGS sharing one security with a large base stays additive (Berkshire Q1-2025 shape)", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2025-05-15" });
  await rows(pg, "o", [{ t: "B1" }, { t: "B2" }, { t: "B3" }, { t: "B4" }, { t: "B5" }, { t: "B6" }, { t: "B7" }, { t: "B8" }]);
  await filing(pg, { id: "n", filed: "2025-08-14", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "n", [{ t: "B1", sh: 999 }, { t: "C1" }, { t: "C2" }, { t: "C3" }]);
  const got = await effective(pg);
  assert.equal(got.length, 12);
  assert.ok(got.includes("B1@n:999") && got.includes("B1@o:100") && got.includes("C3@n:100"));
});

// Value: protects=a genuine NEW HOLDINGS filed before a later mislabelled re-list keeps its confidential positions; fails_when=amendments are compared with the reclassified re-list instead of the declared original; why_new=re-list tests have no earlier NEW HOLDINGS; seam=none
test("a re-list filed after a genuine NEW HOLDINGS doesn't drop that amendment's positions", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "A1" }, { t: "A2" }, { t: "A3" }, { t: "A4" }, { t: "A5" }, { t: "A6" }]);
  await filing(pg, { id: "nh1", filed: "2026-08-10", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "nh1", [{ t: "SECRET", sh: 9 }]);
  await filing(pg, { id: "relist", filed: "2026-08-20", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "relist", [{ t: "A1" }, { t: "A2" }, { t: "A3" }, { t: "A4" }, { t: "A5" }, { t: "A6" }, { t: "NEW1", sh: 7 }]);
  assert.deepEqual(await effective(pg), [
    "A1@relist:100", "A2@relist:100", "A3@relist:100", "A4@relist:100", "A5@relist:100", "A6@relist:100",
    "NEW1@relist:7", "SECRET@nh1:9"]);
});

// Value: protects=a later re-list that corrects an earlier NEW HOLDINGS amendment's share count replaces that position (no 9 + 12); fails_when=the copy check only drops exact copies when the re-list is filed after the amendment; why_new=the previous re-list test repeats nothing from nh1; seam=none
test("a later re-list restating an earlier NEW HOLDINGS position with a new share count counts it once", async () => {
  const pg = await db();
  await filing(pg, { id: "o", filed: "2026-08-05" });
  await rows(pg, "o", [{ t: "A1" }, { t: "A2" }, { t: "A3" }, { t: "A4" }, { t: "A5" }, { t: "A6" }]);
  await filing(pg, { id: "nh1", filed: "2026-08-10", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "nh1", [{ t: "SECRET", sh: 9 }, { t: "OTHER", sh: 3 }]);
  await filing(pg, { id: "relist", filed: "2026-08-20", form: "13F-HR/A", amendment: "NEW HOLDINGS" });
  await rows(pg, "relist", [{ t: "A1" }, { t: "A2" }, { t: "A3" }, { t: "A4" }, { t: "A5" }, { t: "A6" }, { t: "SECRET", sh: 12 }]);
  assert.deepEqual(await effective(pg), [
    "A1@relist:100", "A2@relist:100", "A3@relist:100", "A4@relist:100", "A5@relist:100", "A6@relist:100",
    "OTHER@nh1:3", "SECRET@relist:12"]);
});
