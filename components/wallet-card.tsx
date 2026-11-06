"use client";

import { ArrowUpRight, Droplets } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api-client";
import type { SponsorView } from "@/lib/api-types";
import { formatDuration } from "@/lib/ui/format";
import { Amount, Button, CopyHex, Notice, Skeleton } from "./ui";
import { useWallet } from "./wallet-provider";

export function CardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="wallet-card relative overflow-hidden rounded-2xl p-5 text-white ring-1 ring-white/10">
      <span aria-hidden="true" className="wallet-card-grid pointer-events-none absolute inset-0" />
      <div className="relative">{children}</div>
    </div>
  );
}

function SponsorNotice({ sponsor, deployed }: { sponsor: SponsorView; deployed: boolean }) {
  if (sponsor.stationEmpty) {
    return (
      <Notice tone="danger" title="The gas sponsor is out of funds">
        Transactions stop until someone funds the gas station. Your funds are safe.
      </Notice>
    );
  }
  if (sponsor.used >= sponsor.limit) {
    return (
      <Notice tone="warning" title="The daily gas budget is used up">
        This wallet used all {sponsor.limit} sponsored transactions for today. The budget resets at
        midnight UTC.
      </Notice>
    );
  }
  return (
    <Notice title="Gas sponsored">
      {deployed ? "" : "The sponsor deploys this wallet at your first transaction. "}
      The wallet needs no ETH. Fund gives test tokens. {sponsor.used} of {sponsor.limit} sponsored
      transactions used today. This runs on the local network only.
    </Notice>
  );
}

export function WalletCardSkeleton() {
  return <Skeleton className="h-52 rounded-2xl" />;
}

export function WalletCard({ onSend }: { onSend: () => void }) {
  const { wallet, account, info, offline, refresh, tokenBy } = useWallet();
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!wallet) return null;

  const fund = async () => {
    setFunding(true);
    setError(null);
    try {
      await api.faucet(wallet.address);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The faucet failed.");
    } finally {
      setFunding(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <CardFrame>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-white/70">Wallet</p>
            <CopyHex value={wallet.address} className="focus-visible:ring-white" />
          </div>
          {account && !account.deployed ? (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">Not deployed yet</span>
          ) : null}
        </div>

        <dl className="mt-3 flex flex-col gap-1">
          {account
            ? account.balances.map((balance) => {
                const token = tokenBy(balance.token);
                if (!token) return null;
                return (
                  <div key={balance.token} className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-white/70">
                      {token.isTest ? token.name : token.symbol}
                    </dt>
                    <dd>
                      <Amount
                        value={balance.amount}
                        decimals={token.decimals}
                        symbol={token.symbol}
                        className="text-xl font-semibold"
                      />
                    </dd>
                  </div>
                );
              })
            : [0, 1].map((key) => (
                <div key={key} className="h-7 rounded-lg bg-white/10" aria-hidden="true" />
              ))}
        </dl>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="onCard" onClick={onSend} disabled={!account || offline}>
            <ArrowUpRight aria-hidden="true" className="size-4" />
            Send
          </Button>
          <Button variant="onCardGhost" onClick={fund} disabled={funding || offline || !info}>
            <Droplets aria-hidden="true" className="size-4" />
            {funding ? "Funding…" : "Fund"}
          </Button>
        </div>
      </CardFrame>

      {account?.sponsor ? (
        <SponsorNotice sponsor={account.sponsor} deployed={account.deployed} />
      ) : account && !account.deployed ? (
        <Notice title="Your first transaction deploys this wallet">
          The wallet pays its own gas. Use Fund first. Test funds only.
        </Notice>
      ) : null}
      {account && account.demoDelay > 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          Demo delay: {formatDuration(account.demoDelay).toLowerCase()} (real: 24 hours to 7 days)
        </p>
      ) : null}
      {error ? <Notice tone="danger" title="The faucet failed">{error}</Notice> : null}
    </div>
  );
}
