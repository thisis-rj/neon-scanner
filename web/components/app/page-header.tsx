import { cn } from "cn";

// Title + one-paragraph explainer + a quiet row of observable facts
// (counts, freshness). Facts only — no derived "health" numbers (§2.4).
export function PageHeader({
  title,
  description,
  meta,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4 md:flex-row md:items-end md:justify-between", className)}>
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && (
          <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{description}</p>
        )}
        {meta && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}
