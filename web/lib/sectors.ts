// Lines on the /sectors overlay chart. Order = color order (fixed, never
// cycled): slots 1-8 solid in chart-1..8, lines 9-12 dashed in chart-1..4.
// Keep `symbol` in sync with SYMBOLS in ingest/sector_prices.py.
export type SectorLine = { key: string; symbol: string; label: string; what: string };

export const SECTOR_LINES: SectorLine[] = [
  { key: "btc", symbol: "BTC-USD", label: "Bitcoin", what: "BTC / USD" },
  { key: "gold", symbol: "GC=F", label: "Gold", what: "Gold futures, $ per oz" },
  { key: "silver", symbol: "SI=F", label: "Silver", what: "Silver futures, $ per oz" },
  { key: "semis", symbol: "SMH", label: "Semiconductors", what: "VanEck Semiconductor ETF (SMH)" },
  { key: "defense", symbol: "ITA", label: "Defense", what: "iShares Aerospace & Defense ETF (ITA)" },
  { key: "power", symbol: "XLU", label: "Utilities / power", what: "Utilities Select Sector SPDR (XLU)" },
  { key: "uranium", symbol: "URA", label: "Uranium", what: "Global X Uranium ETF (URA)" },
  { key: "energy", symbol: "XLE", label: "Energy", what: "Energy Select Sector SPDR (XLE)" },
  { key: "financials", symbol: "XLF", label: "Financials", what: "Financial Select Sector SPDR (XLF)" },
  { key: "healthcare", symbol: "XLV", label: "Healthcare", what: "Health Care Select Sector SPDR (XLV)" },
  { key: "software", symbol: "IGV", label: "Software", what: "iShares Expanded Tech-Software ETF (IGV)" },
  { key: "miners", symbol: "WGMI", label: "Bitcoin miners", what: "Valkyrie Bitcoin Miners ETF (WGMI)" },
];

export function lineStyle(i: number): { color: string; dashed: boolean } {
  return { color: `var(--chart-${(i % 8) + 1})`, dashed: i >= 8 };
}

// One row per US trading day (SMH's calendar); Bitcoin and futures are
// carried forward to those days so every line has a value on every row.
export type SectorRow = { date: string } & Record<string, number | string | null>;
