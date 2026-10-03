import {
  FORMS,
  CONCEPTS,
  FORM4_CODES,
  FILER_CATEGORIES,
  DIRECTIONS,
  type GlossaryEntry,
} from "@/lib/glossary";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// /learn — comprehensive glossary, always one click away from the nav.
// Designed for someone without a finance background.

function slugFor(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const formEntries = Object.values(FORMS).filter(
  // De-dup: 'SC 13D' and 'SCHEDULE 13D' have the same definition; keep one
  (e, i, arr) => arr.findIndex((x) => x.term === e.term) === i,
);

const SECTIONS: { id: string; title: string; description: string; entries: GlossaryEntry[] }[] = [
  { id: "forms", title: "SEC filing types", description: "Each filing type has a specific legal trigger and time window. The signal strength varies.", entries: formEntries },
  { id: "categories", title: "Filer categories", description: "How we group the tracked filers. Drives the colored bar on the left of rows and cards.", entries: FILER_CATEGORIES },
  { id: "directions", title: "Direction labels (13D events)", description: "Computed by comparing each 13D filing to the same filer's previous filing on the same issuer.", entries: DIRECTIONS },
  { id: "form4", title: "Form 4 transaction codes", description: "Each line of a Form 4 has a single-letter code. Most are noise; P (purchase) is the signal.", entries: FORM4_CODES },
  { id: "concepts", title: "Other concepts", description: "Identifiers and metadata you'll see throughout the app.", entries: CONCEPTS },
];

function Entry({ e }: { e: GlossaryEntry }) {
  return (
    <Card
      id={slugFor(e.term)}
      size="sm"
      className="scroll-mt-20 target:ring-2 target:ring-primary/60"
    >
      <CardHeader>
        <CardTitle>{e.term}</CardTitle>
        <CardDescription className="italic">{e.short}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="leading-relaxed text-pretty">{e.meaning}</p>
        {e.example && (
          <p className="rounded-md border-l-2 border-primary/50 bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Example. </span>
            {e.example}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function LearnPage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Learn"
        description="The framework rests on a small number of SEC filing types and concepts. This page defines every term used elsewhere in the app — keep it open in a tab while you're learning the domain."
      />

      <div className="grid gap-10 lg:grid-cols-[13rem_1fr]">
        <nav className="hidden lg:block" aria-label="Glossary sections">
          <ul className="sticky top-20 flex flex-col gap-1 text-sm">
            {[{ id: "big-picture", title: "The big picture" }, ...SECTIONS, { id: "how-to-use", title: "How to use it" }].map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="block rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex max-w-3xl flex-col gap-12">
          <Card id="big-picture" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>The big picture</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 leading-relaxed text-pretty">
              <p>
                Wealthy investors and corporate insiders are <em>legally required</em> to disclose what they own. The SEC publishes these disclosures publicly. Our system pulls in those filings, normalizes them, and surfaces the ones from a curated list of high-signal investors. The bet: some investors are demonstrably better than average at picking stocks, so watching their disclosures can inform your own decisions.
              </p>
              <p className="text-muted-foreground">
                The system <strong className="text-foreground">does not</strong>{" "}tell you what to buy. It surfaces who&apos;s doing what, and you decide. Most of the value is in the activist (13D) and insider-buy (Form 4 code P) data — those are timely and intentional. Quarterly 13F holdings tell a slower story.
              </p>
            </CardContent>
          </Card>

          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="flex scroll-mt-20 flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold tracking-tight">{s.title}</h2>
                <p className="text-sm text-muted-foreground">{s.description}</p>
              </div>
              <div className="flex flex-col gap-3">
                {s.entries.map((e) => <Entry key={e.term} e={e} />)}
              </div>
            </section>
          ))}

          <Card id="how-to-use" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>How to use the framework</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex list-decimal flex-col gap-2 pl-5 leading-relaxed text-pretty">
                <li><strong>Start with Signals and Clusters.</strong> Signals shows tickers where several tracked sources fire at once; Clusters shows 3+ insiders buying the same stock.</li>
                <li><strong>Click through to sec.gov</strong> on anything that catches your eye. For a 13D, read Item 4 to see what the activist intends to do.</li>
                <li><strong>Check Holdings</strong>{" "}to see which tracked filers own the name and whether they were adding or trimming — that&apos;s confluence.</li>
                <li><strong>Use the Filings log</strong> as the raw bibliography of everything ingested.</li>
                <li><strong>Decide yourself.</strong> The system never tells you what to buy.</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
