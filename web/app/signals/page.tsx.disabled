import { supabaseServer } from "@/lib/supabase";
import { getWatchlist } from "@/lib/watchlist";
import { WatchlistToggle } from "@/components/WatchlistToggle";
import { filerInfoByName, filerShortLabel } from "@/lib/filers";
import Link from "next/link";

// Force dynamic rendering — same reason as /holdings. Statically rendered
// pages serve build-time data; this page reads from signals_latest which
// changes hourly during filing seasons.
export const dynamic = "force-dynamic";

// /signals — BUY signal table, read from signals_latest.
// Default threshold: score ≥ 7. Filter at top: text box "min score".

type Signal = {
  ticker: string;
  score: number;
  num_sources: number;
  components: {
    insider_cluster?: { n: number; score: number };
    thirteenf_new?: { n: number; score: number };
    thirteenf_add?: { n: number; score: number };
    activist_13d?: { n: number; score: number };
    share_velocity?: { n: number; score: number };
    cross_q_confluence?: { n: number; score: number };
    multi_source_bonus?: { applied: boolean; n_types: number; score: number };
  };
  contributing_filers: {
    new?: string[];
    add?: string[];
    velocity?: [string, number][];
    activist?: string[];
    insider_buyers?: string[];
  } | null;
  first_detected_at: string | null;
  latest_signal_at: string | null;
  aum_usd: number | null;
  price: number | null;
  return_1m: number | null;
  return_6m: number | null;
  return_ytd: number | null;
  computed_at: string;
};

function fmtPct(v: number | null) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function pctColor(v: number | null) {
  if (v == null) return "text-neutral-500";
  if (v > 0) return "text-emerald-400";
  if (v < 0) return "text-red-400";
  return "text-neutral-400";
}
function fmtAum(v: number | null) {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}

type SortKey = "score" | "latest_signal" | "first_detected";

async function fetchSignals(sort: SortKey): Promise<(Signal & { company_name: string | null })[]> {
  const sb = supabaseServer();
  const col = sort === "latest_signal" ? "latest_signal_at"
            : sort === "first_detected" ? "first_detected_at"
            : "score";
  // Fetch signals + tickers.name in one trip
  const out: Signal[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("signals_latest")
      .select("*")
      .order(col, { ascending: false, nullsFirst: false })
      .order("score", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as Signal[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  // Fetch ticker→name map (companies in our universe)
  const tickerSet = Array.from(new Set(out.map((s) => s.ticker)));
  const nameMap = new Map<string, string>();
  for (let i = 0; i < tickerSet.length; i += 500) {
    const batch = tickerSet.slice(i, i + 500);
    const { data } = await sb
      .from("tickers")
      .select("ticker,name")
      .in("ticker", batch);
    for (const row of data || []) {
      if (row.ticker && row.name) nameMap.set(row.ticker, row.name);
    }
  }
  return out.map((s) => ({ ...s, company_name: nameMap.get(s.ticker) ?? null }));
}

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ min_score?: string; sort?: string }>;
}) {
  const sp = await searchParams;
  const minScore = sp.min_score ? parseFloat(sp.min_score) : 7;
  const sortKey: SortKey = sp.sort === "latest_signal" ? "latest_signal"
                        : sp.sort === "first_detected" ? "first_detected"
                        : "score";
  const [allSignals, watchlistSet] = await Promise.all([fetchSignals(sortKey), getWatchlist()]);
  const signals = allSignals.filter((s) => s.score >= minScore);
  const totalCount = allSignals.length;
  const lastComputed = allSignals[0]?.computed_at ?? null;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Signals — BUY confluence</h1>
        <p className="text-sm text-neutral-400">
          Tickers where multiple smart-money sources are firing. Score is a transparent
          sum of 7 signal types (see column header tooltips). No LLM, no advice —
          just what the filings say.
        </p>
        <p className="text-xs text-neutral-500">
          {totalCount} signals computed{lastComputed ? ` at ${new Date(lastComputed).toLocaleString()}` : ""}.
          Showing {signals.length} with score ≥ {minScore}.
          {" · "}
          <Link href="/signals/analysis" className="text-emerald-400 hover:underline">
            View deep analysis ({watchlistSet.size} watchlisted)
          </Link>
        </p>
      </header>

      {/* Score filter + sort */}
      <form method="get" className="flex items-center gap-3 text-sm flex-wrap">
        <label htmlFor="min_score" className="text-neutral-400">Min score:</label>
        <input
          type="number"
          id="min_score"
          name="min_score"
          defaultValue={minScore}
          step="0.5"
          min="0"
          className="w-24 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100 focus:outline-none focus:border-emerald-600"
        />
        <label htmlFor="sort" className="text-neutral-400 ml-3">Sort by:</label>
        <select
          id="sort"
          name="sort"
          defaultValue={sortKey}
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-neutral-100 focus:outline-none focus:border-emerald-600"
        >
          <option value="score">Score (desc)</option>
          <option value="latest_signal">Latest signal date (desc)</option>
          <option value="first_detected">First detected date (desc)</option>
        </select>
        <button
          type="submit"
          className="px-3 py-1 rounded bg-emerald-900/40 border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/60"
        >
          Apply
        </button>
        <span className="text-xs text-neutral-500">
          (try 7 for clean signal, 15 for high-confluence, 20 for top tier)
        </span>
      </form>

      {/* Signals table */}
      {signals.length === 0 ? (
        <div className="rounded-md border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          No signals at this threshold.
        </div>
      ) : (
        <div className="rounded-md border border-neutral-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-xs uppercase tracking-wider text-neutral-400">
              <tr>
                <th className="px-2 py-2 font-medium w-10" title="Add to watchlist for deep analysis"></th>
                <th className="px-3 py-2 font-medium">Ticker</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium text-right" title="Sum of all 7 signal-type contributions">Score</th>
                <th className="px-3 py-2 font-medium text-right" title="How many of the 7 signal types are firing">Sources</th>
                <th className="px-3 py-2 font-medium text-xs" title="Signal breakdown: ins=insider cluster, new=13F new positions, add=13F adds, 13d=activist 13D, vel=share-count velocity, xq=cross-quarter confluence">Breakdown</th>
                <th className="px-3 py-2 font-medium" title="Notable filers firing this signal (hover for full list)">Top filers</th>
                <th className="px-3 py-2 font-medium" title="Earliest filing date among contributing signals">First detected</th>
                <th className="px-3 py-2 font-medium" title="Latest filing date among contributing signals">Latest signal</th>
                <th className="px-3 py-2 font-medium text-right">Market Cap</th>
                <th className="px-3 py-2 font-medium text-right">1M</th>
                <th className="px-3 py-2 font-medium text-right">6M</th>
                <th className="px-3 py-2 font-medium text-right">YTD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {signals.map((s) => {
                const c = s.components || {};
                const breakdown = [
                  c.insider_cluster?.n ? `ins=${c.insider_cluster.n}` : null,
                  c.thirteenf_new?.n ? `new=${c.thirteenf_new.n}` : null,
                  c.thirteenf_add?.n ? `add=${c.thirteenf_add.n}` : null,
                  c.activist_13d?.n ? `13d=${c.activist_13d.n}` : null,
                  c.share_velocity?.n ? `vel=${c.share_velocity.n}` : null,
                  c.cross_q_confluence?.n ? `xq=${c.cross_q_confluence.n}` : null,
                ].filter(Boolean).join(" ");
                const star = c.multi_source_bonus?.applied;
                const tooltipLines = [
                  c.insider_cluster?.n ? `Insiders buying (30d): ${c.insider_cluster.n}` : null,
                  c.thirteenf_new?.n ? `13F new positions: ${c.thirteenf_new.n}  (${(s.contributing_filers?.new || []).slice(0, 3).join(', ')})` : null,
                  c.thirteenf_add?.n ? `13F adds: ${c.thirteenf_add.n}  (${(s.contributing_filers?.add || []).slice(0, 3).join(', ')})` : null,
                  c.activist_13d?.n ? `Activist 13D: ${c.activist_13d.n}` : null,
                  c.share_velocity?.n ? `Share-count velocity (2x+): ${c.share_velocity.n}` : null,
                  c.cross_q_confluence?.n ? `Cross-Q confluence filers: ${c.cross_q_confluence.n}` : null,
                ].filter(Boolean).join("\n");
                // Build top filer list across signal types
                const allFilers: string[] = [];
                const cf = s.contributing_filers || {};
                for (const f of cf.activist ?? []) allFilers.push(f);
                for (const [f] of cf.velocity ?? []) allFilers.push(f);
                for (const f of cf.new ?? []) allFilers.push(f);
                for (const f of cf.add ?? []) allFilers.push(f);
                for (const f of cf.insider_buyers ?? []) allFilers.push(f);
                const seenFiler = new Set<string>();
                const dedupFilers = allFilers.filter((f) => { if (seenFiler.has(f)) return false; seenFiler.add(f); return true; });
                const topFilersDisplay = dedupFilers.slice(0, 2);
                const allFilersTooltip = dedupFilers.join("\n");
                return (
                  <tr key={s.ticker} className="hover:bg-neutral-900/40">
                    <td className="px-2 py-2">
                      <WatchlistToggle ticker={s.ticker} initialAdded={watchlistSet.has(s.ticker)} />
                    </td>
                    <td className="px-3 py-2 font-mono text-neutral-100">{s.ticker}</td>
                    <td className="px-3 py-2 text-neutral-300 max-w-xs truncate" title={s.company_name ?? ""}>{s.company_name ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {star && <span className="text-amber-300 mr-1" title="Multi-source bonus (3+ signal types)">★</span>}
                      <span className="text-neutral-100 font-medium">{s.score.toFixed(1)}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-300 tabular-nums">{s.num_sources}</td>
                    <td className="px-3 py-2 text-xs text-neutral-400 font-mono whitespace-nowrap" title={tooltipLines}>{breakdown}</td>
                    <td className="px-3 py-2 text-xs text-neutral-400 max-w-md" title={allFilersTooltip}>
                      <div className="flex flex-wrap gap-x-2 gap-y-1">
                        {topFilersDisplay.map((fullName, i) => {
                          const info = filerInfoByName(fullName);
                          const t = info?.signalTier ?? "B";
                          const tierColor =
                            t === "S" ? "bg-emerald-600/30 text-emerald-300 border border-emerald-700/50" :
                            t === "A" ? "bg-sky-600/30 text-sky-300 border border-sky-700/50" :
                            t === "C" ? "bg-neutral-800 text-neutral-500 border border-neutral-700" :
                                        "bg-neutral-800 text-neutral-400 border border-neutral-700";
                          return (
                            <span key={i} className="inline-flex items-baseline gap-1 whitespace-nowrap" title={info?.badge || fullName}>
                              <span className={`px-1 text-[10px] font-mono rounded ${tierColor}`}>{t}</span>
                              <span className="text-neutral-300">{filerShortLabel(fullName)}</span>
                              {info?.badge && (
                                <span className="text-neutral-500 italic text-[11px]">— {info.badge}</span>
                              )}
                            </span>
                          );
                        })}
                        {dedupFilers.length > 2 && (
                          <span className="text-neutral-500 italic">+{dedupFilers.length - 2} more</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-400 tabular-nums">{s.first_detected_at ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-neutral-400 tabular-nums">{s.latest_signal_at ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-neutral-300 tabular-nums">{fmtAum(s.aum_usd)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(s.return_1m)}`}>{fmtPct(s.return_1m)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(s.return_6m)}`}>{fmtPct(s.return_6m)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(s.return_ytd)}`}>{fmtPct(s.return_ytd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="text-xs text-neutral-500 pt-4 border-t border-neutral-900 space-y-1">
        <p>
          <span className="text-amber-300">★</span> = multi-source bonus (3+ different signal types firing on the same ticker).
        </p>
        <p>
          Score components: insider cluster (Lakonishok-Lee, 30d window), 13F new positions, 13F adds (≥20%), activist 13D, share-count velocity (≥2x Q-over-Q), cross-quarter confluence (3+ distinct filers across 2 quarters). Multi-source bonus (+5) when 3+ types fire.
        </p>
        <p>
          Refreshed nightly. Hover any cell for detail. Returns from yfinance. 13F data is 45-day delayed by SEC rule.
        </p>
      </footer>
    </div>
  );
}
