import { ArrowDownLeft, ArrowUpRight, Ban, Settings2 } from "lucide-react";
import type { Tx } from "../data";
import { fmtToken } from "../lib/format";
import { IconCircle } from "./ui";

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

  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <IconCircle icon={ICONS[tx.kind]} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold">{tx.title}</p>
        <p className="truncate text-sm text-muted">{tx.subtitle}</p>
      </div>
      {amount}
    </li>
  );
}
