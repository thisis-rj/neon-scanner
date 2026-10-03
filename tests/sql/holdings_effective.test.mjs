// Tests for the holdings_13f_effective view and holdings_recent() RPC (migration 023).
//
// Runs the real migration SQL in PGlite (Postgres compiled to WASM), so the
// view's replace/union rules are checked without touching Supabase.
//   cd tests/sql && npm ci && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(new URL("../../schema/migrations/023_holdings_effective.sql", import.meta.url), "utf8");

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
);`;

async function db() {
  const pg = new PGlite();
  await pg.exec(BASE_SCHEMA);
  await pg.exec(MIGRATION);
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
    `select filing_id, ticker, shares from holdings_13f_effective where cik = $1 and period_of_report = $2 order by ticker, filing_id, shares`,
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
  const r = await pg.query(`select period_of_report::text as p, ticker, put_call, filer_name from holdings_recent(2) order by p, ticker`);
  assert.deepEqual(
    r.rows.map((x) => `${x.p} ${x.ticker} ${x.put_call}`),
    ["2026-03-31 AAA null", "2026-06-30 AAA null", "2026-06-30 SECRET null"],
  );
  assert.equal(r.rows[0].filer_name, "Fund 1");
});

test("migration is re-runnable", async () => {
  const pg = await db();
  await pg.exec(MIGRATION);
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
