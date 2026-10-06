"use client";

import { useEffect, useState } from "react";
import { EarningsAnswer } from "@/components/app/earnings-test/answer";
import { EarningsExplorer } from "@/components/app/earnings-test/explorer";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { decodeEvents, type ExploreEvent, type Wire } from "@/lib/earnings-explore";

// The Answer and Advanced tabs share one download of /earnings-test/data
// (~14k reports), fetched once per page view and kept in memory.

type Loaded = { events: ExploreEvent[]; spyDates: string[]; spyRet: number[]; sectors: string[] };
let pending: Promise<Loaded> | null = null;

function load(): Promise<Loaded> {
  pending ??= fetch("/earnings-test/data")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<Wire>;
    })
    .then((w) => ({ events: decodeEvents(w), spyDates: w.spyDates, spyRet: w.spyRet, sectors: w.sectors }))
    .catch((e) => {
      pending = null; // let a later mount retry
      throw e;
    });
  return pending;
}

function useData() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && setData(d),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  return { data, error };
}

function State({ error }: { error: string | null }) {
  if (error)
    return (
      <Empty className="border py-16">
        <EmptyDescription>Couldn&rsquo;t load the reports ({error}). Reload to retry.</EmptyDescription>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function AnswerTab() {
  const { data, error } = useData();
  if (!data) return <State error={error} />;
  return (
    <EarningsAnswer
      events={data.events}
      spyDates={data.spyDates}
      spyRet={data.spyRet}
      hasLive={data.events.some((e) => e.src === "live")}
    />
  );
}

export function AdvancedTab() {
  const { data, error } = useData();
  if (!data) return <State error={error} />;
  return (
    <EarningsExplorer
      events={data.events}
      spyDates={data.spyDates}
      spyRet={data.spyRet}
      sectors={data.sectors}
      hasLive={data.events.some((e) => e.src === "live")}
    />
  );
}
