"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenIcon, MenuIcon } from "lucide-react";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const NAV = [
  { href: "/", label: "Filings" },
  { href: "/holdings", label: "Holdings" },
  { href: "/events", label: "Clusters" },
  { href: "/corporate", label: "Corporate events" },
  { href: "/earnings", label: "Earnings" },
  { href: "/my-stocks", label: "My Stocks" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="neon-glow flex size-6 items-center justify-center rounded-md bg-brand/15 font-mono text-xs text-brand">
        N
      </span>
      <span>Neon Scanner</span>
    </Link>
  );
}

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Logo />

        <nav className="hidden flex-1 items-center gap-0.5 md:flex">
          {NAV.map((item) => (
            <Button
              key={item.href}
              asChild
              size="sm"
              variant={isActive(pathname, item.href) ? "secondary" : "ghost"}
              className={isActive(pathname, item.href) ? undefined : "text-muted-foreground"}
            >
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <Button
            asChild
            size="sm"
            variant={isActive(pathname, "/learn") ? "secondary" : "ghost"}
            className="hidden text-muted-foreground md:inline-flex"
          >
            <Link href="/learn">
              <BookOpenIcon data-icon="inline-start" />
              Learn
            </Link>
          </Button>

          <ThemeToggle className="text-muted-foreground" />

          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72">
              <SheetHeader>
                <SheetTitle>Neon Scanner</SheetTitle>
                <SheetDescription>Signals from SEC filings. No FOMO, no narrative.</SheetDescription>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-4">
                {[...NAV, { href: "/learn", label: "Learn" }].map((item) => (
                  <SheetClose key={item.href} asChild>
                    <Button
                      asChild
                      variant={isActive(pathname, item.href) ? "secondary" : "ghost"}
                      className="justify-start"
                    >
                      <Link href={item.href}>{item.label}</Link>
                    </Button>
                  </SheetClose>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
          </div>
      </div>
      <div className="neon-rule h-px" />
    </header>
  );
}
