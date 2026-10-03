"use client";

import { BriefcaseIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PEOPLE = ["Riya", "Vijay"] as const;

// Empty shell for the My Stocks tab — two sub-tabs (Riya / Vijay). Holdings +
// scanner overlay get wired in once the portfolios are provided.
export function MyStocksTabs() {
  return (
    <Tabs defaultValue={PEOPLE[0]} className="gap-4">
      <TabsList variant="line">
        {PEOPLE.map((p) => (
          <TabsTrigger key={p} value={p}>{p}</TabsTrigger>
        ))}
      </TabsList>
      {PEOPLE.map((p) => (
        <TabsContent key={p} value={p}>
          <Empty className="border py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BriefcaseIcon />
              </EmptyMedia>
              <EmptyTitle>No holdings yet</EmptyTitle>
              <EmptyDescription>{p}&rsquo;s holdings will go here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </TabsContent>
      ))}
    </Tabs>
  );
}
