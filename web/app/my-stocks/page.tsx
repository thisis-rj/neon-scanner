import { MyStocksTabs } from "@/components/MyStocksTabs";

export const dynamic = "force-dynamic";

export default function MyStocksPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">My Stocks</h1>
        <p className="mt-2 text-sm text-neutral-400 max-w-3xl">
          Personal portfolios, crossed with the scanner. Empty for now — holdings coming next.
        </p>
      </header>
      <MyStocksTabs />
    </div>
  );
}
