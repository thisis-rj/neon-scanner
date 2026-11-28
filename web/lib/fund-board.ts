// Riya's fund board (Nov 2026): which tracked funds the site shows, and why.
//
// Vijay: this does NOT change config/tracked_filers.yml or any ingest — all
// funds are still collected. Pages filter to BOARD for display only.
//
// Rule (agreed with Riya, 28 Nov 2026), vs the S&P 500 total return for the
// same calendar years (2023 +26.2%, 2024 +24.9%, 2025 +17.7%):
//   • full 3 years published → keep if it beat the S&P in ≥2 of the 3 years,
//     or beat it over the 3 years combined;
//   • only some years published (private funds, press figures) → keep if it
//     beat the S&P in EVERY year we have, shown as an ESTIMATE;
//   • legends kept regardless: Druckenmiller, Klarman, Buffett, Tepper, Singer, Marks.
// Every number below is a published/reported figure with its source — nothing
// is computed by us. null = not published for that year.

export type BoardMark = "2of3" | "3yr" | "all_reported" | "legend";

export type BoardFund = {
  cik: string;
  mark: BoardMark;
  returns: { 2023: number | null; 2024: number | null; 2025: number | null }; // % for the calendar year
  estimate: boolean; // press/unofficial figure, not published by the fund
  basis: string; // what the number is
  source: string; // link
  note?: string;
};

export const SP500 = { 2023: 26.2, 2024: 24.9, 2025: 17.7 } as const;

export const BOARD: BoardFund[] = [
  // ── beat the S&P in ≥2 of 3 years ─────────────────────────────────────────
  { cik: "0001061165", mark: "2of3", returns: { 2023: 19, 2024: 36, 2025: 23 }, estimate: true, basis: "Lone Pine long-short fund (press)", source: "https://www.hedgeweek.com/light-street-leads-stock-picking-hedge-funds-with-37-2025-gain/" },
  { cik: "0001510387", mark: "2of3", returns: { 2023: 25.34, 2024: 27.96, 2025: 21.18 }, estimate: false, basis: "Gotham Enhanced Return fund (GENIX)", source: "https://finance.yahoo.com/quote/GENIX/performance/" },
  { cik: "0000859804", mark: "2of3", returns: { 2023: 29.1, 2024: 30.01, 2025: 4.43 }, estimate: false, basis: "Wedgewood fund (RWGIX)", source: "https://finance.yahoo.com/quote/RWGIX/performance/" },
  { cik: "0001336528", mark: "2of3", returns: { 2023: 26.7, 2024: 10.2, 2025: 20.9 }, estimate: false, basis: "Pershing Square Holdings NAV (official)", source: "https://assets.pershingsquareholdings.com/wp-content/uploads/2026/02/18175039/Pershing-Square-Holdings-Ltd.-2025-Annual-Report.pdf" },
  { cik: "0001056831", mark: "2of3", returns: { 2023: 46.72, 2024: -17.44, 2025: 29.49 }, estimate: false, basis: "Fairholme fund (FAIRX)", source: "https://finance.yahoo.com/quote/FAIRX/performance/" },
  // ── beat the S&P over the 3 years combined ────────────────────────────────
  { cik: "0001020066", mark: "3yr", returns: { 2023: 52.16, 2024: 24.19, 2025: 15.67 }, estimate: false, basis: "Sands Capital Select Growth fund (CISGX)", source: "https://finance.yahoo.com/quote/CISGX/performance/", note: "Beat the S&P over 2023–25 combined (+118.6% vs +85.5%); by single year only 2023." },
  // ── beat the S&P in every year we have (partial data, estimates) ─────────
  { cik: "0001747057", mark: "all_reported", returns: { 2023: null, 2024: 44.6, 2025: 33.7 }, estimate: true, basis: "D1 stock book (press)", source: "https://www.institutionalinvestor.com/article/hedge-funds/rich-list-institutional-investors-25th-annual-ranking-highest-earning-hedge" },
  { cik: "0000934639", mark: "all_reported", returns: { 2023: 29, 2024: 25, 2025: null }, estimate: true, basis: "Maverick Fund (press)", source: "https://www.institutionalinvestor.com/article/2ds18reksyn3h314pi4g0/hedge-funds/tiger-cub-maverick-flirts-with-a-major-milestone" },
  { cik: "0001569049", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: 37 }, estimate: true, basis: "Light Street (press)", source: "https://www.hedgeweek.com/light-street-leads-stock-picking-hedge-funds-with-37-2025-gain/" },
  { cik: "0001387322", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: 27 }, estimate: true, basis: "Whale Rock (press)", source: "https://www.hedgeweek.com/light-street-leads-stock-picking-hedge-funds-with-37-2025-gain/" },
  { cik: "0001115373", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: 41.4 }, estimate: false, basis: "Semper Augustus 2025 client letter (net)", source: "https://valueinvestingworld.substack.com/p/semper-augustus-investments-group-b5c" },
  { cik: "0002045724", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: 200 }, estimate: true, basis: "Situational Awareness, about +200% (unnamed sources)", source: "https://www.barchart.com/story/news/2370001/leopold-aschenbrenners-situational-awareness-surpasses-20-billion-as-ai-focused-hedge-fund-gains-270-in-2026", note: "Started 2024. Lost ~67% in July 2026 and sold its public stock book to Citadel." },
  { cik: "0001224962", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: 82 }, estimate: true, basis: "Perceptive (press)", source: "https://www.institutionalinvestor.com/article/biopharma-funds-deliver-market-beating-returns-valuations-snap-back" },
  { cik: "0001346824", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: 38.6 }, estimate: true, basis: "RA Capital, through November 2025 (press)", source: "https://www.institutionalinvestor.com/article/biopharma-funds-deliver-market-beating-returns-valuations-snap-back" },
  { cik: "0001534261", mark: "all_reported", returns: { 2023: null, 2024: null, 2025: null }, estimate: true, basis: "Casdin, \"up in the 20 percent range\" through November 2025 (press)", source: "https://www.institutionalinvestor.com/article/biopharma-funds-deliver-market-beating-returns-valuations-snap-back", note: "Only a range was reported (about +20s% through Nov 2025)." },
  // ── legends (kept regardless of the rule) ─────────────────────────────────
  { cik: "0001536411", mark: "legend", returns: { 2023: null, 2024: null, 2025: null }, estimate: false, basis: "Not published (family office since 2010)", source: "https://en.wikipedia.org/wiki/Stanley_Druckenmiller", note: "Duquesne Capital 1981–2010: ~30% a year, no losing year (press-reported)." },
  { cik: "0001061768", mark: "legend", returns: { 2023: null, 2024: null, 2025: null }, estimate: false, basis: "Not published (private partnership)", source: "https://www.bloomberg.com/news/articles/2025-01-22/baupost-clients-pulled-7-billion-since-2021-after-poor-returns", note: "Bloomberg (Jan 2025): ~4% a year over the last decade." },
  { cik: "0001067983", mark: "legend", returns: { 2023: 15.5, 2024: 27.1, 2025: 10.9 }, estimate: false, basis: "Berkshire share price (BRK-B); 2025 matches Berkshire's letter", source: "https://www.morningstar.com/stocks/berkshire-hathaway-greg-abel-goes-conservative-with-his-debut-annual-letter-shareholders" },
  { cik: "0001656456", mark: "legend", returns: { 2023: 18.5, 2024: null, 2025: 23.3 }, estimate: true, basis: "Appaloosa (press; 2023 reported as 18–19%)", source: "https://www.institutionalinvestor.com/article/hedge-funds/rich-list-institutional-investors-25th-annual-ranking-highest-earning-hedge" },
  { cik: "0001791786", mark: "legend", returns: { 2023: null, 2024: null, 2025: 7 }, estimate: true, basis: "Elliott (press)", source: "https://www.institutionalinvestor.com/article/hedge-funds/rich-list-institutional-investors-25th-annual-ranking-highest-earning-hedge", note: "~13% a year since 1977 with only two losing years (press)." },
  { cik: "0000949509", mark: "legend", returns: { 2023: null, 2024: null, 2025: null }, estimate: false, basis: "Not comparable (mainly a credit/bond manager)", source: "https://www.oaktreecapital.com/" },
];

const BY_CIK = new Map(BOARD.map((b) => [b.cik, b]));
export const BOARD_CIKS = new Set(BOARD.map((b) => b.cik));

export function boardFund(cik: string | null | undefined): BoardFund | null {
  if (!cik) return null;
  return BY_CIK.get(cik.padStart(10, "0")) ?? null;
}
export function onBoard(cik: string | null | undefined): boolean {
  return !!boardFund(cik);
}

export const MARK_TEXT: Record<BoardMark, string> = {
  "2of3": "Beat S&P 2 of 3 yrs",
  "3yr": "Beat S&P over 3 yrs",
  all_reported: "Beat S&P every reported yr",
  legend: "Legend",
};

/** One-line tooltip: "2023 +19% · 2024 +36% · 2025 +23% (S&P +26/+25/+18) · estimate · source" */
export function boardTooltip(b: BoardFund): string {
  const yr = (y: 2023 | 2024 | 2025) => (b.returns[y] == null ? `${y} n/a` : `${y} ${b.returns[y]! >= 0 ? "+" : ""}${b.returns[y]}%`);
  return [
    `${yr(2023)} · ${yr(2024)} · ${yr(2025)}`,
    `S&P: 2023 +${SP500[2023]}% · 2024 +${SP500[2024]}% · 2025 +${SP500[2025]}%`,
    `${b.basis}${b.estimate ? " — ESTIMATE (not published by the fund)" : ""}`,
    b.note ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
