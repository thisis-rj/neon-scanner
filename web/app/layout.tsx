import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/components/app/site-header";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Neon Scanner",
  description:
    "Signal extraction from SEC filings by 30 tracked investors. No FOMO, no narrative.",
};

// CLAUDE.md §9 — these caveats live in the UI, on every page.
const CAVEATS = [
  "13F data is 45 days delayed by law.",
  "Filer intent is inferred, not stated. Read the filing.",
  "Past activist returns do not predict future ones.",
  "No signals this week is the expected state most weeks.",
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <TooltipProvider delayDuration={150}>
          <SiteHeader />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>
          <footer className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6">
            <Separator className="mb-4" />
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-4">
              {CAVEATS.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </footer>
        </TooltipProvider>
      </body>
    </html>
  );
}
