import { ArrowUpRightIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { daysAgo, fmtSignedPct, shortDate } from "@/lib/format";

// Small, reusable table cells. Kept presentational: every value shown is
// read straight from a filing or a price feed — nothing derived here.

/** Signed % in positive/negative tone. `fraction` = 0.12 means 12%. */
export function Pct({
  value,
  fraction = false,
  className,
}: {
  value: number | null | undefined;
  fraction?: boolean;
  className?: string;
}) {
  if (value == null) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span
      className={cn(
        "tabular-nums",
        value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted-foreground",
        className,
      )}
    >
      {fmtSignedPct(value, fraction)}
    </span>
  );
}

export type Tier = "S" | "A" | "B" | "C";

const TIER_VARIANT = { S: "brand", A: "info", B: "muted", C: "muted" } as const;

/** S/A/B/C signal-quality tier of a tracked filer. */
export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <Badge
      variant={TIER_VARIANT[tier]}
      className={cn("h-4 rounded-sm px-1 font-mono text-[10px]", tier === "C" && "opacity-70", className)}
      title={`Signal-quality tier ${tier}`}
    >
      {tier}
    </Badge>
  );
}

/** "sec.gov ↗" link to the underlying filing. The filing is the source of truth. */
export function SecLink({ href }: { href: string | null | undefined }) {
  if (!href) return <span className="text-muted-foreground/60">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
    >
      sec.gov
      <ArrowUpRightIcon className="size-3" />
    </a>
  );
}

/** Date with a relative "3d ago" underneath. */
export function DateCell({ iso }: { iso: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="font-mono text-xs tabular-nums">{shortDate(iso)}</span>
      <span className="text-[11px] text-muted-foreground">{daysAgo(iso)}</span>
    </div>
  );
}

/** Ticker symbol in mono. */
export function Ticker({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs font-medium tracking-tight", className)}>{children}</span>;
}

/** Inline help: dotted-underlined label that explains itself on hover. */
export function Hint({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-4">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty whitespace-pre-line">{children}</TooltipContent>
    </Tooltip>
  );
}

/** The 45-day 13F caveat (§2.6). Shown wherever 13F-derived data appears. */
export function ThirteenFDelayNote() {
  return (
    <Badge variant="warning" className="font-normal">
      13F data is 45 days delayed by law
    </Badge>
  );
}
