import { Badge } from "@/components/ui/badge";
import { boardFund, boardTooltip, MARK_TEXT } from "@/lib/fund-board";

// Why a fund is on Riya's board (lib/fund-board.ts): mark + "estimate" flag;
// hover for the yearly returns, the S&P comparison and the basis; click for the source.
export function BoardBadge({ cik, className }: { cik: string | null | undefined; className?: string }) {
  const b = boardFund(cik);
  if (!b) return null;
  return (
    <a href={b.source} target="_blank" rel="noreferrer" title={boardTooltip(b)} className={className}>
      <Badge variant={b.mark === "legend" ? "warning" : "positive"} className="cursor-help font-normal">
        {b.mark === "legend" ? "⭐ " : "✓ "}
        {MARK_TEXT[b.mark]}
        {b.estimate && <span className="ml-1 opacity-80">· estimate</span>}
      </Badge>
    </a>
  );
}
