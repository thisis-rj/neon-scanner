"use client";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Tab toggle for each filer card on /holdings. Three views:
//   "current"  — top 10 latest positions (the snapshot table)
//   "changes"  — News + Adds (positive moves vs prior 13F)
//   "sold"     — Exits + Major Trims (negative moves vs prior 13F)
//
// Per CLAUDE.md §2.3 — exits get equal prominence to entries. Sold lives
// in its own tab, same size and weight as Bought, so a glance at any
// filer's rotation tells you what they bought AND what they shed.
//
// All three views are server-rendered and passed in as props; switching
// tabs is purely client-side. No router push, no re-fetch.

export function FilerCardTabs({
  current,
  changes,
  sold,
  changesCount,
  soldCount,
}: {
  current: React.ReactNode;
  changes: React.ReactNode;
  sold: React.ReactNode;
  changesCount: number;
  soldCount: number;
}) {
  return (
    <Tabs defaultValue="current" className="gap-0">
      <div className="border-b px-4 pb-2">
        <TabsList variant="line">
          <TabsTrigger value="current" className="text-xs">Current</TabsTrigger>
          <TabsTrigger value="changes" className="text-xs">
            Bought
            {changesCount > 0 && <Badge variant="positive" className="h-4 px-1.5 text-[10px] tabular-nums">{changesCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="sold" className="text-xs">
            Sold
            {soldCount > 0 && <Badge variant="negative" className="h-4 px-1.5 text-[10px] tabular-nums">{soldCount}</Badge>}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="current">{current}</TabsContent>
      <TabsContent value="changes">{changes}</TabsContent>
      <TabsContent value="sold">{sold}</TabsContent>
    </Tabs>
  );
}
