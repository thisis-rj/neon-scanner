"use client";

import { useState, useTransition } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleWatchlist } from "@/lib/watchlist";

export function WatchlistToggle({ ticker, initialAdded }: { ticker: string; initialAdded: boolean }) {
  const [added, setAdded] = useState(initialAdded);
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="icon-xs"
      variant={added ? "secondary" : "ghost"}
      disabled={pending}
      aria-pressed={added}
      aria-label={added ? `Remove ${ticker} from watchlist` : `Add ${ticker} to watchlist`}
      title={added ? "Remove from watchlist" : "Add to watchlist"}
      className={added ? "text-primary" : "text-muted-foreground"}
      onClick={() => {
        startTransition(async () => {
          const result = await toggleWatchlist(ticker);
          setAdded(result.added);
        });
      }}
    >
      {added ? <CheckIcon /> : <PlusIcon />}
    </Button>
  );
}
