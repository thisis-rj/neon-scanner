// CIK → tracked-filer metadata. Sourced from config/tracked_filers.yml.
// When that YAML is edited, also update this map (small list, stable; not worth
// runtime-loading the YAML in a Next.js server component yet).
//
// Categories:
//   activist             — 13D-filers who push for change; highest signal
//   value, concentrated  — long-horizon equity managers
//   growth               — growth/tech books (Tiger cubs)
//   corporate_strategic  — public companies; signal is in 8-K + 13D, not 13F
//
// Multiplier matches signal_weights.yml. activists 2.0, corp strategic 1.5,
// everyone else 1.0. This drives row priority highlighting in tables.

export type FilerCategory =
  | "value"
  | "concentrated"
  | "growth"
  | "activist"
  | "macro"
  | "corporate_strategic";

// Signal-class describes WHAT kind of picks the filer makes, distinct from
// category. 'thesis_driven' = each position is a human-decided bet (Buffett,
// Ackman, etc.). 'algorithmic_basket' = positions chosen by quant models
// (RenTech, stat-arb funds). We exclude algorithmic_basket from our list
// because individual position changes don't carry "smart-money read X" signal.
export type SignalClass = "thesis_driven" | "algorithmic_basket";

export type FilerInfo = {
  cik: string;
  entity: string;       // company-name entity
  manager: string | null;
  category: FilerCategory;
  multiplier: number;

  // signal_quality tier — added May 2026. S/A/B/C ranks signal quality
  // *within* a category. Multiplies category multiplier in compute_buy_signals.py
  // (S = 1.5×, A = 1.2×, B = 1.0×, C = 0.7×). Source of truth: config/tracked_filers.yml.
  signalTier: "S" | "A" | "B" | "C";
  // badge — 2-4 word plain-English description of what this manager is known
  // for. Surfaced in /signals UI alongside the name. E.g. "Buys when everyone
  // panics" for Tepper. Source of truth: config/tracked_filers.yml.
  badge: string;

  // coverage_pct: rough estimate of what fraction of this filer's TOTAL book
  // their 13F captures. US-listed equity-only funds: ~95%. Macro / credit /
  // FX-heavy funds: much less. Used to weight signals downstream so we don't
  // over-react to a small slice of someone's book.
  coverage_pct: number;  // 0..1
  signal_class: SignalClass;
  bio?: string;
  publishes_letters?: boolean;  // optional UX hint; not a gate
};

const FILERS_LIST: FilerInfo[] = [
  // ─── value / generalists ────────────────────────────────────────────────
  { cik: "0001067983", entity: "Berkshire Hathaway",         manager: "Buffett",        category: "value", multiplier: 1.0, coverage_pct: 0.90, signal_class: "thesis_driven", publishes_letters: true, bio: "Warren Buffett. 60+ years of compounding. Concentrated equity book, $300B+ AUM. Apple is the biggest position. The benchmark.", signalTier: "S", badge: "Buys best businesses forever" },
  { cik: "0001536411", entity: "Duquesne Family Office",     manager: "Druckenmiller",  category: "value", multiplier: 1.0, coverage_pct: 0.30, signal_class: "thesis_driven", publishes_letters: false, bio: "Stanley Druckenmiller. ~30% annualized over 30 years, no down years. Famously broke the Bank of England in '92. Macro-driven — 13F shows only the US-equity slice (~30% of book).", signalTier: "S", badge: "Trades the future early" },
  { cik: "0001061768", entity: "Baupost Group",              manager: "Klarman",        category: "value", multiplier: 1.0, coverage_pct: 0.40, signal_class: "thesis_driven", publishes_letters: false, bio: "Seth Klarman. Deep value, distressed credit, special situations. Author of Margin of Safety. 13F shows the equity slice (~40%); rest is credit/distressed.", signalTier: "S", badge: "Waits years for true bargains" },
  { cik: "0001656456", entity: "Appaloosa Management",       manager: "Tepper",         category: "value", multiplier: 1.0, coverage_pct: 0.50, signal_class: "thesis_driven", publishes_letters: false, bio: "David Tepper. Macro + distressed. Famously bullish on banks in March 2009. Owns the Carolina Panthers. 13F shows the long-equity portion.", signalTier: "S", badge: "Buys when everyone panics" },
  { cik: "0000949509", entity: "Oaktree Capital",            manager: "Marks",          category: "value", multiplier: 1.0, coverage_pct: 0.20, signal_class: "thesis_driven", publishes_letters: true, bio: "Howard Marks. Mostly credit/distressed — 13F equity slice small. His memos are the real signal source.", signalTier: "S", badge: "Buys at the cycle bottom" },
  { cik: "0001079114", entity: "Greenlight Capital",         manager: "Einhorn",        category: "value", multiplier: 1.0, coverage_pct: 0.80, signal_class: "thesis_driven", publishes_letters: true, bio: "David Einhorn. Long/short value. Called Lehman in 2008. Recent years pivoted back to deep-value with notable wins.", signalTier: "A", badge: "Spots frauds, buys cheap" },
  { cik: "0001510387", entity: "Gotham Asset Management",    manager: "Greenblatt",     category: "value", multiplier: 1.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: true, bio: "Joel Greenblatt. Special situations + the 'Magic Formula' value approach. Wrote The Little Book That Beats the Market.", signalTier: "B", badge: "Formula-driven cheap stocks" },
  { cik: "0001056831", entity: "Fairholme Capital",          manager: "Berkowitz",      category: "value", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Bruce Berkowitz. Extreme concentration — fund is essentially 75% St. Joe Company + Sears legacy positions.", signalTier: "C", badge: "Concentrated value (struggled)" },
  { cik: "0000915191", entity: "Fairfax Financial",          manager: "Watsa",          category: "value", multiplier: 1.0, coverage_pct: 0.70, signal_class: "thesis_driven", publishes_letters: true, bio: "Prem Watsa. Often called 'Canada's Buffett'. Insurance + concentrated equity. Long-term contrarian.", signalTier: "B", badge: "Holds quality businesses long-term" },
  { cik: "0000807985", entity: "Southeastern Asset Management",manager: "Hawkins",      category: "value", multiplier: 1.0, coverage_pct: 0.90, signal_class: "thesis_driven", publishes_letters: true, bio: "Mason Hawkins / Longleaf Partners. 50+ year value firm. Concentrated, contrarian, long-horizon. Famous for sticking with positions through painful drawdowns.", signalTier: "C", badge: "Holds value long-term (faded)" },
  { cik: "0001325447", entity: "First Eagle Investment Management", manager: "McLennan", category: "value", multiplier: 1.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: true, bio: "Matthew McLennan. Global value with a gold-as-hedge philosophy (founded by Jean-Marie Eveillard). Quality bias, mid-cap fundamentals focus.", signalTier: "B", badge: "Quality stocks + gold tilt" },

  // ─── concentrated / contrarian ─────────────────────────────────────────
  { cik: "0001649339", entity: "Scion Asset Management",     manager: "Burry",          category: "concentrated", multiplier: 1.0, coverage_pct: 0.70, signal_class: "thesis_driven", publishes_letters: false, bio: "Michael Burry. Famous from The Big Short. Often hedged via options (some hedges show in 13F); often contrarian; occasionally devastatingly right.", signalTier: "S", badge: "Bets against bubbles early" },
  { cik: "0001115373", entity: "Semper Augustus Investments",manager: "Bloomstran",     category: "concentrated", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: true, bio: "Chris Bloomstran. Quiet, deep-value, concentrated. Publishes a widely-read annual analysis of Berkshire Hathaway.", signalTier: "B", badge: "Few concentrated value bets" },
  { cik: "0001697868", entity: "Valley Forge Capital",       manager: "Kantesaria",     category: "concentrated", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Dev Kantesaria. Quality compounders, concentrated. Strong recent returns (~20% annualized).", signalTier: "B", badge: "Few concentrated quality bets" },
  { cik: "0001542302", entity: "Lyrical Asset Management",   manager: "Wellington",     category: "concentrated", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Andrew Wellington. Deep value small-cap. Quiet, disciplined, consistent.", signalTier: "B", badge: "Formula-driven cheap stocks" },
  { cik: "0002045724", entity: "Situational Awareness LP",   manager: "Aschenbrenner",  category: "concentrated", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: true, bio: "Leopold Aschenbrenner, ex-OpenAI superalignment. Launched 2024 on the thesis of his viral 'Situational Awareness' essay — AGI requires massive compute capex, so buy the picks-and-shovels: power (Bloom Energy, EQT), data center hosting (CoreWeave, Core Scientific, IREN), chips & optics (Intel, Lumentum, Coherent). $5.5B AUM by end of 2025. Filed 13D on Core Scientific Aug 2025. Short track record but highly thesis-coherent.", signalTier: "S", badge: "All-in on AI infrastructure" },
  { cik: "0001112520", entity: "Akre Capital Management",    manager: "Akre",           category: "concentrated", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: true, bio: "Chuck Akre. Quality compounders only — 'three-legged stool' of high return on capital, durable competitive advantage, and management that allocates capital well. Visa, Mastercard, Moody's, KKR. Long holding periods.", signalTier: "A", badge: "Buys best businesses forever" },
  { cik: "0001553733", entity: "Brave Warrior Advisors",     manager: "Greenberg",      category: "concentrated", multiplier: 1.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Glenn Greenberg, ex-Chieftain Capital. Concentrated value, ~15 positions typical. Strong long-term record over multiple decades.", signalTier: "B", badge: "Few concentrated value bets" },
  { cik: "0001138995", entity: "Glenview Capital Management",manager: "Robbins",        category: "concentrated", multiplier: 1.0, coverage_pct: 0.80, signal_class: "thesis_driven", publishes_letters: false, bio: "Larry Robbins. Healthcare-focused concentrated long/short. Major positions in managed care, healthcare services, pharma. Top-10 typically >60% of book.", signalTier: "B", badge: "Healthcare sector specialist" },
  { cik: "0001224962", entity: "Perceptive Advisors",        manager: "Edelman",        category: "concentrated", multiplier: 1.0, coverage_pct: 0.70, signal_class: "thesis_driven", publishes_letters: false, bio: "Joseph Edelman. Biotech specialist — concentrated long/short book in small/mid-cap drug developers. One of the most accomplished biotech investors of the 21st century.", signalTier: "A", badge: "Biotech specialist" },
  { cik: "0001517857", entity: "Soroban Capital Partners",   manager: "Mandelblatt",    category: "concentrated", multiplier: 1.0, coverage_pct: 0.80, signal_class: "thesis_driven", publishes_letters: false, bio: "Eric Mandelblatt, ex-TPG-Axon. Concentrated long/short with low turnover. Multi-billion AUM. Quality + special situations.", signalTier: "B", badge: "Math-driven macro tilts" },

  // ─── growth / tech ──────────────────────────────────────────────────────
  { cik: "0001167483", entity: "Tiger Global Management",    manager: "Coleman",        category: "growth", multiplier: 1.0, coverage_pct: 0.30, signal_class: "thesis_driven", publishes_letters: false, bio: "Chase Coleman, a 'Tiger Cub'. Huge private-company book — 13F shows ~30%. Hard 2022 drawdown on public + private markdowns.", signalTier: "B", badge: "Tech bets (public + private)" },
  { cik: "0001135730", entity: "Coatue Management",          manager: "Laffont",        category: "growth", multiplier: 1.0, coverage_pct: 0.30, signal_class: "thesis_driven", publishes_letters: false, bio: "Phil Laffont. Another Tiger Cub. Growth/tech + private investments. AI-adjacent. 13F shows ~30%.", signalTier: "B", badge: "Tech bets (public + private)" },
  { cik: "0001061165", entity: "Lone Pine Capital",          manager: "Mandel",         category: "growth", multiplier: 1.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: false, bio: "Steve Mandel. Returned outside capital in 2019; now runs private money. One of the best long-term records in growth equities.", signalTier: "A", badge: "Best long-term growth picker" },
  { cik: "0001103804", entity: "Viking Global Investors",    manager: "Halvorsen",      category: "growth", multiplier: 1.0, coverage_pct: 0.70, signal_class: "thesis_driven", publishes_letters: false, bio: "Andreas Halvorsen. Disciplined Tiger Cub. More fundamentals-driven than the other cubs. Strong recent record.", signalTier: "A", badge: "Steady growth, long + short" },
  { cik: "0000934639", entity: "Maverick Capital",           manager: "Ainslie",        category: "growth", multiplier: 1.0, coverage_pct: 0.80, signal_class: "thesis_driven", publishes_letters: false, bio: "Lee Ainslie. Long-time Tiger Cub. Long/short global equities. Mixed recent performance.", signalTier: "B", badge: "Tech: long + short bets" },
  { cik: "0001747057", entity: "D1 Capital Partners",        manager: "Sundheim",       category: "growth", multiplier: 1.0, coverage_pct: 0.50, signal_class: "thesis_driven", publishes_letters: false, bio: "Dan Sundheim, ex-Viking Global CIO. Multi-billion crossover fund — half public equity, half private. 13F captures ~50% of book; private investments are large.", signalTier: "B", badge: "Growth bets (public + private)" },
  { cik: "0001569049", entity: "Light Street Capital",       manager: "Kacher",         category: "growth", multiplier: 1.0, coverage_pct: 0.60, signal_class: "thesis_driven", publishes_letters: false, bio: "Glen Kacher. Tech-focused Tiger Cub. Smaller than the famous Cubs but high-conviction in software/internet/semis.", signalTier: "B", badge: "Tech growth bets" },
  { cik: "0001700574", entity: "Holocene Advisors",          manager: "Haley",          category: "growth", multiplier: 1.0, coverage_pct: 0.65, signal_class: "thesis_driven", publishes_letters: false, bio: "Brandon Haley, ex-Citadel pod manager. Long/short tech, market-neutral-leaning. Net long bias historically.", signalTier: "B", badge: "Math-driven multi-strategy" },

  // ─── activists (multiplier 2.0 — heaviest in scorer) ───────────────────
  { cik: "0001336528", entity: "Pershing Square Capital Management", manager: "Ackman", category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: true, bio: "Bill Ackman. High-profile activist. Big wins on Chipotle, Hilton. Famous losing fights too (Valeant, Herbalife). Loud, public, opinionated.", signalTier: "S", badge: "Big bets, public fights" },
  { cik: "0001040273", entity: "Third Point LLC",            manager: "Loeb",           category: "activist", multiplier: 2.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: true, bio: "Dan Loeb. Activist + event-driven. Known for sharply-worded letters to CEOs and corporate governance fights.", signalTier: "A", badge: "Public fights with CEOs" },
  { cik: "0001412093", entity: "Icahn Capital",              manager: "Icahn",          category: "activist", multiplier: 2.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: false, bio: "Carl Icahn. 88 years old, decades of activist campaigns. Recent years quieter; Icahn Enterprises stock crashed in 2023 after a short report.", signalTier: "C", badge: "Famous old activist (fading)" },
  { cik: "0001345471", entity: "Trian Fund Management",      manager: "Peltz",          category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Nelson Peltz. Constructivist activism — works with management. Big wins on Heinz, PepsiCo, P&G. Recent Disney campaign.", signalTier: "B", badge: "Activist on big brands" },
  { cik: "0001791786", entity: "Elliott Investment Management", manager: "Singer",      category: "activist", multiplier: 2.0, coverage_pct: 0.50, signal_class: "thesis_driven", publishes_letters: false, bio: "Paul Singer. The most aggressive large activist firm. Multi-strategy — equity activism, credit, distressed sovereigns. 13F shows the equity portion.", signalTier: "S", badge: "The most feared activist" },
  { cik: "0001517137", entity: "Starboard Value LP",         manager: "Smith",          category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Jeff Smith. Mid-cap activist. Famous Olive Garden turnaround. Often pushes for sales or strategic alternatives.", signalTier: "A", badge: "Pushes companies to cut costs" },
  { cik: "0001535472", entity: "Corvex Management",          manager: "Meister",        category: "activist", multiplier: 2.0, coverage_pct: 0.90, signal_class: "thesis_driven", publishes_letters: false, bio: "Keith Meister. Carl Icahn's protégé. Selective concentrated activist plays — Southwest Gas, Energen historically.", signalTier: "B", badge: "Mid-size company activist" },
  { cik: "0001418814", entity: "ValueAct Capital Management",manager: "ValueAct",       category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Mason Morfit's firm. Constructive activist that takes board seats. Big Microsoft position helped Satya Nadella's cloud pivot.", signalTier: "A", badge: "Activist without public fight" },
  { cik: "0001817187", entity: "Inclusive Capital Partners", manager: "Ubben",          category: "activist", multiplier: 2.0, coverage_pct: 0.90, signal_class: "thesis_driven", publishes_letters: false, bio: "Jeff Ubben. Founded ValueAct, then left to focus on ESG/impact activism via Inclusive. Fund status reportedly winding down.", signalTier: "B", badge: "Activist for sustainability" },
  { cik: "0001159159", entity: "JANA Partners",              manager: "Rosenstein",     category: "activist", multiplier: 2.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: false, bio: "Barry Rosenstein. Big mid-large cap activist wins: Whole Foods (sold to Amazon), Tiffany. Plays both constructive and confrontational.", signalTier: "B", badge: "Mid-size company activist" },
  { cik: "0001582090", entity: "Sachem Head Capital Management", manager: "Ferguson",   category: "activist", multiplier: 2.0, coverage_pct: 0.85, signal_class: "thesis_driven", publishes_letters: false, bio: "Scott Ferguson, Ackman alum. Concentrated activist book, mid-cap focus.", signalTier: "B", badge: "Mid-size company activist" },
  { cik: "0001695459", entity: "Mantle Ridge LP",            manager: "Hilal",          category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Paul Hilal. Most famous for the CSX activist campaign (replaced CEO with Hunter Harrison). Very concentrated — sometimes ~1-3 positions at a time.", signalTier: "B", badge: "Few concentrated activist bets" },
  { cik: "0001559771", entity: "Engaged Capital",            manager: "Welling",        category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Glenn Welling. Mid-cap activist; constructive in approach. Catches situations the mega-activists ignore.", signalTier: "B", badge: "Small company activist" },
  { cik: "0001665590", entity: "Engine Capital Management",  manager: "Ajdler",         category: "activist", multiplier: 2.0, coverage_pct: 0.95, signal_class: "thesis_driven", publishes_letters: false, bio: "Arnaud Ajdler. Small-cap activist. Operates below the radar of big activists; catches sub-$1B situations.", signalTier: "B", badge: "Tiny company activist" },

  // ─── macro ──────────────────────────────────────────────────────────────
  // Re-added under the softened rule (coverage_pct annotation, not exclusion).
  // Their 13F shows a small slice of mostly-macro books — signal gets
  // de-weighted automatically but isn't silently dropped.
  { cik: "0001420192", entity: "Hayman Capital Management",  manager: "Bass",           category: "macro", multiplier: 1.0, coverage_pct: 0.10, signal_class: "thesis_driven", publishes_letters: false, bio: "Kyle Bass. Sovereign macro/credit specialist. 13F captures ~10% of book — the small US-equity slice. Recent macro calls (Japan, China) have been wrong; track with skepticism.", signalTier: "C", badge: "Bets on country economies" },

  // ─── corporate strategic investors (multiplier 1.5) ─────────────────────
  { cik: "0001045810", entity: "NVIDIA Corporation",         manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "AI compute leader. Strategic investments in AI infrastructure plays (Run:ai, CoreWeave). $5B Intel investment Sep 2025.", signalTier: "S", badge: "Strategic AI stakes" },
  { cik: "0000789019", entity: "Microsoft Corporation",      manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "$13B+ in OpenAI; numerous AI/cloud strategic investments. Capital allocation under Satya Nadella has been highly effective.", signalTier: "A", badge: "Strategic AI partnerships" },
  { cik: "0001652044", entity: "Alphabet Inc.",              manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "Google parent. Anthropic investment, Waymo, DeepMind. Strategic bets shape the AI/cloud landscape.", signalTier: "B", badge: "Strategic AI defense buys" },
  { cik: "0001018724", entity: "Amazon.com, Inc.",           manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "$4B+ in Anthropic, MGM acquisition, Whole Foods. AWS-driven strategic plays.", signalTier: "B", badge: "Strategic AI + logistics buys" },
  { cik: "0001326801", entity: "Meta Platforms, Inc.",       manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "Scale AI partnership, ongoing AI infrastructure bets, occasional acquisitions.", signalTier: "B", badge: "Strategic AI buys" },
  { cik: "0000320193", entity: "Apple Inc.",                 manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "Famously acquisition-light. Major investments rare but signal-bearing when they happen (Beats, supplier stakes).", signalTier: "A", badge: "Rare big strategic moves" },
  { cik: "0001341439", entity: "Oracle Corporation",         manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "Cloud GPU partnerships; OpenAI compute deal. Larry Ellison's strategic bets are concentrated and high-conviction.", signalTier: "B", badge: "Strategic cloud bets" },
  { cik: "0001730168", entity: "Broadcom Inc.",              manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "VMware acquisition was transformative. Semi industry M&A often signals foundry/ecosystem repositioning.", signalTier: "B", badge: "Strategic tech acquisitions" },
  { cik: "0001108524", entity: "Salesforce, Inc.",           manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "Slack acquisition, ongoing AI-startup investments. Marc Benioff's capital allocation is acquisitive.", signalTier: "B", badge: "Strategic AI tools buys" },
  { cik: "0000796343", entity: "Adobe Inc.",                 manager: null, category: "corporate_strategic", multiplier: 1.5, coverage_pct: 1.0, signal_class: "thesis_driven", bio: "Figma deal (blocked) was a $20B signal of where they think creative-tool consolidation is going. Investments are themed around design + AI.", signalTier: "B", badge: "Strategic AI tools buys" },
  // ─── mid-cap / small-cap / sector specialists (auto-synced from YAML) ───
  { cik: "0000906304", entity: "Royce & Associates LP", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap value picks" },
  { cik: "0000814133", entity: "Wasatch Advisors", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap growth picks" },
  { cik: "0001217541", entity: "Diamond Hill Capital Management", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Mid-cap value picks" },
  { cik: "0001027796", entity: "Pzena Investment Management", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "A", badge: "Buys statistically cheap stocks" },
  { cik: "0001164833", entity: "Hotchkis & Wiley Capital Management", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Buys deeply cheap stocks" },
  { cik: "0000732905", entity: "Tweedy, Browne Company", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Classic Graham-style value" },
  { cik: "0001377581", entity: "First Pacific Advisors", manager: "FPA", category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Quality stocks, downside-focused" },
  { cik: "0000860644", entity: "Aristotle Capital Management", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Quality mid-cap growth" },
  { cik: "0001034524", entity: "Polen Capital Management", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Few quality growth stocks" },
  { cik: "0001020066", entity: "Sands Capital Management", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Few quality growth stocks" },
  { cik: "0000859804", entity: "Wedgewood Partners", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Few concentrated growth bets" },
  { cik: "0001279936", entity: "Cantillon Capital Management", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Global quality growth stocks" },
  { cik: "0001263508", entity: "Baker Bros Advisors", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "A", badge: "Top biotech fund" },
  { cik: "0001346824", entity: "RA Capital Management", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Biotech specialist" },
  { cik: "0001534261", entity: "Casdin Capital", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Biotech specialist" },
  { cik: "0001387322", entity: "Whale Rock Capital Management", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Tech sector specialist" },
  { cik: "0001536216", entity: "Macellum Advisors GP", manager: null, category: "activist", multiplier: 2.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Activist on retail companies" },
  { cik: "0001885245", entity: "Politan Capital Management", manager: null, category: "activist", multiplier: 2.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Mid-size company activist" },
  { cik: "0001536520", entity: "Land & Buildings Investment Management", manager: null, category: "activist", multiplier: 2.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "A", badge: "Forces REITs to change" },
  { cik: "0001446114", entity: "Ancora Advisors", manager: null, category: "activist", multiplier: 2.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Mid-size company activist" },
  { cik: "0001167212", entity: "Needham Investment Management", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap tech bets" },
  { cik: "0001512275", entity: "Mill Road Capital Management", manager: null, category: "activist", multiplier: 2.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Small company activist" },
  { cik: "0001279342", entity: "Perritt Capital Management", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Microcap value picks" },
  { cik: "0001591546", entity: "Pacific Ridge Capital Partners", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap value picks" },
  { cik: "0001282683", entity: "Nierenberg Investment Management", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Microcap concentrated bets" },
  { cik: "0001713521", entity: "Bridge City Capital", manager: null, category: "growth", multiplier: 1.0, coverage_pct: 0.75, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap growth picks" },
  { cik: "0001299910", entity: "Skylands Capital", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap value picks" },
  { cik: "0001389234", entity: "Symmetry Peak Management", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Microcap concentrated bets" },
  { cik: "0000917579", entity: "Kestrel Investment Management", manager: null, category: "value", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap value picks" },
  { cik: "0001911372", entity: "Meros Investment Management", manager: null, category: "concentrated", multiplier: 1.0, coverage_pct: 0.9, signal_class: "thesis_driven", signalTier: "B", badge: "Small-cap concentrated bets" },

];

const BY_CIK = new Map(FILERS_LIST.map((f) => [f.cik, f]));

export function filerInfo(cik: string | null | undefined): FilerInfo | null {
  if (!cik) return null;
  return BY_CIK.get(cik.padStart(10, "0")) ?? null;
}

export function allFilers(): FilerInfo[] {
  return FILERS_LIST;
}

// Lookup helper — contributing_filers in signals_latest stores filers as
// "Entity (Manager)" strings (e.g. "Duquesne Family Office (Druckenmiller)").
// This map lets the UI resolve tier + badge from that string.
const BY_NAME = new Map<string, FilerInfo>();
for (const f of FILERS_LIST) {
  const fullName = f.manager ? `${f.entity} (${f.manager})` : f.entity;
  BY_NAME.set(fullName, f);
}
export function filerInfoByName(name: string | null | undefined): FilerInfo | null {
  if (!name) return null;
  return BY_NAME.get(name) ?? null;
}

// Short label for table display: manager surname if present, else entity.
export function filerShortLabel(name: string | null | undefined): string {
  if (!name) return "";
  const info = BY_NAME.get(name);
  if (info?.manager) return info.manager;
  // No metadata — strip parenthetical or return as-is
  return name.replace(/\s*\([^)]+\)\s*$/, "").trim();
}

export function signalTier(cik: string | null | undefined): "S" | "A" | "B" | "C" | null {
  const info = filerInfo(cik);
  return info?.signalTier ?? null;
}

export function badge(cik: string | null | undefined): string {
  return filerInfo(cik)?.badge ?? "";
}

// Visual priority tier for table-row highlighting.
// Higher tier = colored more prominently.
export function tier(cik: string | null | undefined): 0 | 1 | 2 {
  const info = filerInfo(cik);
  if (!info) return 0;
  if (info.category === "activist") return 2; // top tier
  if (info.category === "corporate_strategic") return 1; // mid
  return 0;
}
