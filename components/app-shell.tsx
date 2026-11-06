"use client";

import { Bot, Moon, Settings, Sun, Wallet } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import { Notice, focusRing } from "./ui";
import { WalletProvider, useWallet } from "./wallet-provider";

// The build replaces the variable, so a normal build drops the mock bar.
const MockBar =
  process.env.NEXT_PUBLIC_WAVE_MOCK === "1"
    ? dynamic(() => import("./mock-bar"), { ssr: false })
    : null;

const THEME_KEY = "wave.theme";

function subscribeTheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.getAttribute("data-theme") ?? "light",
    () => "light",
  );
  const next = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={`Use ${next} theme`}
      onClick={() => {
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // The theme still applies until reload.
        }
      }}
      className={`inline-flex size-10 items-center justify-center rounded-lg hover:bg-muted ${focusRing}`}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}

const LINKS = [
  { href: "/", label: "Wallet", icon: Wallet },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {LINKS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-label={label}
          aria-current={pathname === href ? "page" : undefined}
          className={cn(
            `inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium hover:bg-muted ${focusRing}`,
            pathname === href ? "bg-muted" : "text-muted-foreground",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          {/* Three labels do not fit next to the logo at phone width. */}
          <span className="hidden sm:inline">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function NetworkBadge() {
  const { info } = useWallet();
  if (!info) return null;
  return (
    <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
      {info.network === "devnet" ? "Public devnet" : "Local"}
    </span>
  );
}

function ChainBanner() {
  const { offline, error, info, refresh } = useWallet();
  if (offline) {
    return (
      <Notice tone="warning" title="The chain is offline">
        Balances may be out of date. New transactions cannot run.
        {info?.network === "devnet" ? " The public devnet does not answer." : " Start the stack with devnet/up.sh."}
      </Notice>
    );
  }
  if (error) {
    return (
      <Notice
        tone="danger"
        title="WAVE cannot load your data"
        action={
          <button type="button" onClick={() => void refresh()} className="font-medium underline">
            Try again
          </button>
        }
      >
        {error}
      </Notice>
    );
  }
  if (info && !info.sidecarOnline) {
    return (
      <Notice tone="warning" title="The mempool sidecar is offline">
        New transactions cannot run until the sidecar is back.
      </Notice>
    );
  }
  if (info && !info.contractsDeployed) {
    return (
      <Notice tone="warning" title="The contracts are not deployed">
        Deploy the contracts to this network, then reload this page.
      </Notice>
    );
  }
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex max-w-lg items-center justify-between gap-2 px-4 py-2">
          <Link href="/" className={`rounded-lg text-base font-bold tracking-tight ${focusRing}`}>
            WAVE
          </Link>
          <div className="flex items-center gap-1">
            <NetworkBadge />
            <Nav />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-4">
        <ChainBanner />
        {children}
      </main>
      {MockBar ? <MockBar /> : null}
    </WalletProvider>
  );
}
