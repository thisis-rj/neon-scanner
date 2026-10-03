import Link from "next/link";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { cn } from "cn";
import { TableHead } from "@/components/ui/table";

// Column header that sorts by linking to the same page with ?sort=&dir= — the
// sort lives in the URL (bookmarkable) and stays a Server Component.
export function SortableHead({
  href,
  active,
  dir,
  align = "left",
  title,
  className,
  children,
}: {
  href: string;
  active: boolean;
  dir: "asc" | "desc";
  align?: "left" | "right";
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const Icon = !active ? ArrowUpDownIcon : dir === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <TableHead
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", className)}
    >
      <Link
        href={href}
        scroll={false}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 uppercase transition-colors hover:text-foreground",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        {children}
        <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
      </Link>
    </TableHead>
  );
}
