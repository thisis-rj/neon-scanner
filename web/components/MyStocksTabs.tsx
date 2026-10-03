"use client";

import { useState } from "react";

const PEOPLE = ["Riya", "Vijay"] as const;
type Person = (typeof PEOPLE)[number];

// Empty shell for the My Stocks tab — two sub-tabs (Riya / Vijay). Holdings +
// scanner overlay get wired in once the portfolios are provided.
export function MyStocksTabs() {
  const [active, setActive] = useState<Person>("Riya");
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-neutral-800">
        {PEOPLE.map((p) => (
          <button
            key={p}
            onClick={() => setActive(p)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 transition-colors ${
              active === p
                ? "border-neutral-100 text-neutral-100"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="rounded-md border border-neutral-800 p-10 text-center text-sm text-neutral-500">
        {active}&rsquo;s holdings will go here.
      </div>
    </div>
  );
}
