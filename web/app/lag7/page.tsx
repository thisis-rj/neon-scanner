import { Mag7Sleeve } from "@/components/app/mag7/mag7-sleeve";
import { fetchMag7 } from "@/lib/mag7";

export const dynamic = "force-dynamic";

// Lag7 — personal Mag7 laggard sleeve tracker (CLAUDE.md §2.2 note).
export default async function Lag7Page() {
  const data = await fetchMag7();
  return <Mag7Sleeve data={data} editable={Boolean(process.env.MAG7_EDIT_PASSCODE)} />;
}
