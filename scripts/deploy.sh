#!/usr/bin/env bash
# Deploy Neon Scanner — commit + push. Vercel does the rest.
#
# The Vercel project is connected to this GitHub repo (root directory `web`):
#   • push to `main`        → production deploy
#   • push to any other branch → preview deploy at its own URL
# So deploying IS pushing. Never run `vercel --prod` by hand: it would ship
# code that isn't on `main`, and production would drift from git.
#
# ⚠️  Why this script still exists: GitHub auto-disables the daily-ingest
# scheduled workflow after 60 days with no commits to this repo. This bit us
# once: last commit 2026-06-02 → ingest cron disabled ~2026-08-02, two weeks
# of stale data. A no-op run still stamps an empty keep-alive commit so the
# inactivity clock resets.
#
# Usage:  scripts/deploy.sh "commit message"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MSG="${1:-chore: deploy web + keep-alive commit}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git add -A
if git diff --cached --quiet; then
  # No file changes — still stamp an empty keep-alive commit so the 60-day
  # inactivity clock resets even on a no-op redeploy.
  git commit --allow-empty -m "$MSG"
else
  git commit -m "$MSG"
fi
git push origin HEAD

if [ "$BRANCH" = "main" ]; then
  echo "✓ Pushed $(git rev-parse --short HEAD) to main — Vercel is deploying to production."
else
  echo "✓ Pushed $(git rev-parse --short HEAD) to $BRANCH — Vercel is building a preview (not production)."
fi
