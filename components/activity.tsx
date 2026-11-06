"use client";

import { ArrowDownLeft, ArrowUpRight, Dot, ExternalLink } from "lucide-react";
import { useNow } from "@/lib/ui/use-now";
import { explorerTxUrl } from "@/lib/api-client";
import type { ActivityItem } from "@/lib/api-types";
import { formatTime } from "@/lib/ui/format";
import { methodLabel } from "@/lib/ui/rules";
import { Amount, Badge, Card, SectionTitle, Skeleton, focusRing } from "./ui";
import { useWallet } from "./wallet-provider";

const ICONS = { in: ArrowDownLeft, out: ArrowUpRight, none: Dot };

function Row({ item }: { item: ActivityItem }) {
  const { info, tokenBy } = useWallet();
  // The time depends on the browser locale, so it renders after hydration.
  const hydrated = useNow() !== 0;
  const token = item.token ? tokenBy(item.token) : undefined;
  const Icon = ICONS[item.direction];
  const failed = item.state === "failed" || item.state === "dropped";

  return (
    <li className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words">{item.title}</p>
        <p className="text-xs text-muted-foreground">
          {hydrated ? formatTime(item.timestamp) : "--"}
          {item.method ? ` · ${methodLabel(item.method, info?.world)}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-sm">
        {failed ? <Badge tone="danger">Failed</Badge> : null}
        {item.state === "queued" ? <Badge>Queued</Badge> : null}
        {token && item.amount ? (
          // The title holds the amount too, and a phone has no room for both.
          <Amount
            value={item.amount}
            decimals={token.decimals}
            symbol={token.symbol}
            className="hidden sm:inline"
          />
        ) : null}
        {info ? (
          <a
            href={explorerTxUrl(info, item.txHash)}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in the explorer"
            className={`inline-flex size-10 items-center justify-center rounded-lg hover:bg-muted ${focusRing}`}
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function Activity() {
  const { activity, loading, account } = useWallet();

  if (!activity) {
    return loading || !account ? <Skeleton className="h-28 rounded-2xl" /> : null;
  }

  return (
    <Card>
      <SectionTitle>Activity</SectionTitle>
      {activity.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No transactions yet. Use Fund, then send your first transfer.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {activity.map((item) => (
            <Row key={item.txHash} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}
