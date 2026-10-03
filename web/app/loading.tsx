import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Every page reads Supabase live on each request (force-dynamic), which can
// take a second or two. Show the page's shape instead of a blank screen.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading">
      <div className="flex max-w-3xl flex-col gap-3">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
