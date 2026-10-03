import { MyStocksTabs } from "@/components/MyStocksTabs";
import { PageHeader } from "@/components/app/page-header";

export const dynamic = "force-dynamic";

export default function MyStocksPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="My Stocks"
        description="Personal portfolios, crossed with the scanner. Empty for now — holdings coming next."
      />
      <MyStocksTabs />
    </div>
  );
}
