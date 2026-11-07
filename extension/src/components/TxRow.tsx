import { ArrowDownLeft, ArrowUpRight, Ban, ExternalLink, Settings2 } from "lucide-react";
import type { Tx } from "../data";
import { fmtToken } from "../lib/format";
import { IconCircle, focusRing } from "./ui";

const ICONS = { out: ArrowUpRight, in: ArrowDownLeft, cancelled: Ban, config: Settings2 };

export function TxRow({ tx }: { tx: Tx }) {
  const amount =
    tx.amount !== undefined && tx.token ? (
      <span
        className={`shrink-0 text-[15px] font-semibold tabular-nums ${
          tx.kind === "in" ? "text-positive" : tx.kind === "cancelled" ? "text-muted line-through" : "text-ink"
        }`}
      >
        {tx.kind === "in" ? "+ " : ""}
        {fmtToken(tx.amount, tx.token)}
      </span>
    ) : null;

  const body = (
    <>
      <IconCircle icon={ICONS[tx.kind]} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold">{tx.title}</p>
        <p className="flex items-center gap-1 truncate text-sm text-muted">
          {tx.subtitle}
          {tx.href && <ExternalLink className="size-3 shrink-0" aria-hidden />}
        </p>
        {tx.hash && <p className="truncate font-mono text-xs text-muted">{tx.hash}</p>}
      </div>
      {amount}
    </>
  );

  return (
    <li>
      {tx.href ? (
        <a
          href={tx.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${tx.title}, ${tx.subtitle}. Opens the block explorer.`}
          className={`flex items-center gap-4 px-5 py-3 hover:bg-surface ${focusRing}`}
        >
          {body}
        </a>
      ) : (
        <div className="flex items-center gap-4 px-5 py-3">{body}</div>
      )}
    </li>
  );
}
