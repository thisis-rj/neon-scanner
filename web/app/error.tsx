"use client";

import { useEffect } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// A failed Supabase read should say so plainly — never render a half-empty
// page that looks like "no signals" (§2.5: empty must mean empty).
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 py-12">
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Couldn&apos;t load this page</AlertTitle>
        <AlertDescription>
          The data read failed, so nothing below would be trustworthy. This is an error, not an empty
          result.
          {error.digest && <span className="mt-1 block font-mono text-xs">ref {error.digest}</span>}
        </AlertDescription>
      </Alert>
      <Button variant="outline" className="self-start" onClick={() => unstable_retry()}>
        Try again
      </Button>
    </div>
  );
}
