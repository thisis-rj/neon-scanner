#!/usr/bin/env bash
# Neon Scanner — MANUAL / DEV ingest pipeline.
#
# ⚠️  Automation lives in .github/workflows/daily-ingest.yml (cloud).
#     This script is for manual one-off catch-up runs from a developer Mac,
#     NOT for scheduled automation. The launchd plist was removed 2026-05-14
#     because cloud-only is the policy.
#
# Use cases:
#   - Backfill after the cloud workflow had a multi-day outage
#   - Test pipeline changes locally before pushing
#   - Force-refresh signals immediately without waiting for 22:00 UTC
#
# Per CLAUDE.md §7.8: daily 18:00 ET → filings + price snapshot + signals.
# Idempotent — safe to re-run; everything upserts on conflict.
#
# Pipeline (daily):
#   1)  EDGAR poll for all tracked filers (13F/13D/Form 4/8-K headers)
#   2)  Form 4 universe — open-market insider buys, last 7 days
#   3)  Parse new 13F filings  → holdings_13f
#   4)  Parse new 13D filings  → events_13d
#   5)  Parse new Form 4 filings (tracked filers) → events_form4
#   6)  Summarize new 8-K filings (Groq)
#   7)  Daily prices + universe classification
#   8)  Recompute confluence buy signals → signals_latest
#   9)  ETF flows dashboard refresh (Yahoo AUM, iShares, etf_metrics)
#  10) Mondays only: public N-PORT XML refresh
#
# Pipeline (weekly, Sundays):
#  11) Analyst pass on watchlist (Groq) — skip-recent 168h
#
# Logs to /tmp/neon_scanner_$(date +%Y%m%d).log

set -euo pipefail

PROJECT_ROOT="/Users/riyajain/Desktop/portfolio-scanner"
PYTHON="$PROJECT_ROOT/.venv/bin/python"
LOGFILE="/tmp/neon_scanner_$(date +%Y%m%d).log"

cd "$PROJECT_ROOT"

echo "════════════════════════════════════════════════════════════" >> "$LOGFILE"
echo "Ingest run at $(date)"                                          >> "$LOGFILE"
echo "════════════════════════════════════════════════════════════" >> "$LOGFILE"

run_step() {
  local name="$1"
  shift
  echo ""                                                            >> "$LOGFILE"
  echo "── $name ──"                                                 >> "$LOGFILE"
  if "$@" >> "$LOGFILE" 2>&1; then
    echo "✓ $name OK"                                                >> "$LOGFILE"
  else
    echo "✗ $name FAILED (exit $?)"                                  >> "$LOGFILE"
    # Don't abort the whole pipeline — continue with later steps
  fi
}

# ─── Filings ingest (the part that was missing) ──────────────────────────
run_step "EDGAR poll"           "$PYTHON" -m ingest.edgar
run_step "Form 4 universe"      "$PYTHON" -m ingest.form4_universe --days 7
run_step "Parse 13F"            "$PYTHON" -m ingest.parse_13f
run_step "Parse 13D"            "$PYTHON" -m ingest.parse_13d
run_step "Parse Form 4"         "$PYTHON" -m ingest.parse_form4
run_step "Summarize 8-K"        "$PYTHON" -m ingest.summarize_8k

# ─── Prices + signals ────────────────────────────────────────────────────
run_step "Prices"               "$PYTHON" -m ingest.prices
run_step "Compute buy signals"  "$PYTHON" -m ingest.compute_buy_signals
run_step "Compute fund flows"   "$PYTHON" -m ingest.compute_fund_flows

# ─── ETF flows pipeline (original) ───────────────────────────────────────
run_step "Yahoo AUM"            "$PYTHON" -m ingest.etf_aum_yahoo
run_step "iShares daily"        "$PYTHON" -m ingest.etf_shares_ishares --days 7

# Mondays only — public N-PORT XML refresh
if [ "$(date +%u)" = "1" ]; then
  run_step "Public N-PORT XML"  "$PYTHON" -m ingest.etf_flows --years 1
fi

# Always rebuild the ETF dashboard read model last so it picks up new data
run_step "etf_metrics rebuild"  "$PYTHON" -m ingest.etf_metrics

# ─── Weekly analyst pass (Sundays) — uses Groq, paced at ~10 RPM ─────────
if [ "$(date +%u)" = "7" ]; then
  run_step "Analyst pass"       "$PYTHON" -m ingest.analyze_ticker --watchlist --skip-recent 168
fi

echo ""                                                              >> "$LOGFILE"
echo "Done at $(date)"                                               >> "$LOGFILE"
