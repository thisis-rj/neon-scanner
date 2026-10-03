"use client";

import { useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TierBadge } from "@/components/app/cells";

// S/A/B/C tier filter for /holdings.
//
// Architecture choice (May 2026): all cards render server-side with a
// data-tier attribute. This client component manages selected state +
// imperatively toggles `.hidden` on card elements via DOM. Avoids the
// Next.js 16 router.push() + useSearchParams reactivity gotcha that
// kept the checkboxes from updating. Also instant — no server roundtrip
// per toggle.
//
// URL sync via window.history.replaceState so the selection is
// bookmarkable + survives back/forward, without re-rendering the page.

const ALL_TIERS = ["S", "A", "B", "C"] as const;
type Tier = (typeof ALL_TIERS)[number];

function parseFromURL(): Tier[] {
  if (typeof window === "undefined") return [...ALL_TIERS];
  const raw = new URLSearchParams(window.location.search).get("tier");
  if (!raw) return [...ALL_TIERS];
  const tiers = raw.split(",").filter((t): t is Tier => (ALL_TIERS as readonly string[]).includes(t));
  return tiers.length === 0 ? [...ALL_TIERS] : tiers;
}

function applyFilter(selected: Set<Tier>) {
  // Find every card with a data-tier attribute and toggle .hidden based on selection.
  const cards = document.querySelectorAll<HTMLElement>("[data-tier]");
  let visibleCount = 0;
  cards.forEach((el) => {
    const t = el.dataset.tier as Tier | undefined;
    const show = t ? selected.has(t) : true;
    el.classList.toggle("hidden", !show);
    if (show) visibleCount++;
  });
  // Show/hide the "no filers match" empty state
  const empty = document.getElementById("tier-filter-empty");
  if (empty) empty.classList.toggle("hidden", visibleCount > 0);
}

function writeURL(selected: Set<Tier>) {
  const params = new URLSearchParams(window.location.search);
  if (selected.size === 0 || selected.size === ALL_TIERS.length) {
    params.delete("tier");
  } else {
    params.set("tier", Array.from(selected).sort().join(","));
  }
  const qs = params.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

export function TierFilter({ counts }: { counts: Record<Tier, number> }) {
  const [selected, setSelected] = useState<Tier[]>(() => parseFromURL());

  // Apply filter to DOM on every state change (including initial render after hydration).
  useEffect(() => {
    const set = new Set(selected);
    applyFilter(set);
    writeURL(set);
  }, [selected]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Signal tier</span>
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        spacing={1}
        value={selected}
        onValueChange={(v) => setSelected(v as Tier[])}
        aria-label="Filter filers by signal tier"
      >
        {ALL_TIERS.map((t) => (
          <ToggleGroupItem key={t} value={t} aria-label={`Tier ${t}`} className="gap-1.5 data-[state=off]:opacity-50">
            <TierBadge tier={t} />
            <span className="text-xs text-muted-foreground tabular-nums">{counts[t] ?? 0}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
