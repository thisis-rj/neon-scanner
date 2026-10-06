import { fetchExplorerWire } from "@/lib/earnings-test";

// Every measured report's ±30-day return path + context, for the Answer and
// Advanced tabs (computed in the browser). Served once and cached at the CDN
// for an hour: it only changes when the nightly job measures new reports.
export const dynamic = "force-dynamic";

export async function GET() {
  const wire = await fetchExplorerWire();
  return Response.json(wire, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
