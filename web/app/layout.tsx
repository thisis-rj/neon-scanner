import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Neon Scanner",
  description:
    "Signal extraction from SEC filings by 30 tracked investors. No FOMO, no narrative.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-200">
        <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            Neon Scanner
          </Link>
          <nav className="flex gap-4 text-sm text-neutral-400 flex-1">
            <Link href="/" className="hover:text-neutral-100">Filings</Link>
            <Link href="/holdings" className="hover:text-neutral-100">Holdings</Link>
            <Link href="/events" className="hover:text-neutral-100">Clusters</Link>
            <Link href="/corporate" className="hover:text-neutral-100">Corporate events</Link>
            <Link href="/earnings" className="hover:text-neutral-100">Earnings</Link>
            <Link href="/my-stocks" className="hover:text-neutral-100">My Stocks</Link>
          </nav>
          <Link href="/learn" className="text-sm text-neutral-400 hover:text-neutral-100 border-l border-neutral-800 pl-4">
            Learn
          </Link>
        </header>
        <main className="flex-1 px-6 py-6">{children}</main>
        <footer className="border-t border-neutral-800 px-6 py-3 text-xs text-neutral-500">
          13F data is 45 days delayed by law. Filer intent is inferred, not stated. Read the filing.
        </footer>
      </body>
    </html>
  );
}
