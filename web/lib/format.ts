// Human-readable form type labels. Source-of-truth is filings_raw.form_type.

const LABELS: Record<string, string> = {
  "13F-HR": "13F holdings",
  "13F-HR/A": "13F amendment",
  "SC 13D": "13D activist stake",
  "SC 13D/A": "13D amendment",
  "SC 13G": "13G passive 5%+",
  "SC 13G/A": "13G amendment",
  "SCHEDULE 13D": "13D activist stake",
  "SCHEDULE 13D/A": "13D amendment",
  "SCHEDULE 13G": "13G passive 5%+",
  "SCHEDULE 13G/A": "13G amendment",
  "4": "Form 4 insider",
  "4/A": "Form 4 amendment",
  "8-K": "8-K material event",
  "8-K/A": "8-K amendment",
};

/**
 * Extract the manager's personal name from a tracked-filer entity name.
 * "Pershing Square Capital Management (Ackman)" → "Ackman"
 * "Berkshire Hathaway (Buffett)"                → "Buffett"
 * "NVIDIA Corporation"                          → null (no parenthetical)
 *
 * For Form-4 reporter names that already look like person-names
 * (e.g. "O'Sullivan Michael J."), pass through unchanged.
 */
export function managerName(filerName: string | null): string | null {
  if (!filerName) return null;
  const m = filerName.match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : null;
}

export function formLabel(t: string): string {
  return LABELS[t] ?? t;
}

export function shortDate(iso: string): string {
  // iso is "YYYY-MM-DDT..." — just slice
  return iso.slice(0, 10);
}

export function daysAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Number formatting (shared by every table) ──────────────────────────────

/** $1.2T · $3.4B · $8.5M · $42M · $310K · $950. Null → "—". */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e7) return `$${(n / 1e6).toFixed(0)}M`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** $124,312 — exact dollars for ledgers and order sizes. Null → "—". */
export function fmtUsdExact(n: number | null | undefined, cents = false): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/** 412.3712 — fractional share counts, up to 4 decimals. Null → "—". */
export function fmtSharesExact(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** 1.2M · 45K · 950. Null → "—". */
export function fmtShares(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

/** "+12.3%" / "-4.0%". `fraction` = input is 0.123 rather than 12.3. */
export function fmtSignedPct(v: number | null | undefined, fraction = false): string {
  if (v == null) return "—";
  const pct = fraction ? v * 100 : v;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
