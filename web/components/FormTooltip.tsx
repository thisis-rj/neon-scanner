"use client";

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { FORMS } from "@/lib/glossary";

// Try several lookups so we can pass either "13D/A" or "SC 13D/A".
function lookupForm(label: string) {
  return FORMS[label] ?? FORMS[`SCHEDULE ${label}`] ?? FORMS[`SC ${label}`] ?? null;
}

// Slug from the canonical term label (matches anchors on /learn).
function slugFor(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Form-type code (e.g. "13G/A") with a hover card defining it and a
 * "Learn more" link to the matching /learn section.
 */
export function FormTooltip({ term }: { term: string }) {
  const entry = lookupForm(term);
  const title = entry?.term ?? term;

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="cursor-help font-mono text-xs underline decoration-muted-foreground/50 decoration-dotted underline-offset-4"
        >
          {term}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="flex w-72 flex-col gap-1.5">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{entry?.short ?? term}</p>
        <Link
          href={`/learn#${slugFor(title)}`}
          className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
        >
          Learn more <ArrowRightIcon className="size-3" />
        </Link>
      </HoverCardContent>
    </HoverCard>
  );
}
