import { ChartNoAxesColumn, Eye, EyeOff, Gauge, Hourglass, Landmark, List, Plus, RefreshCw, ScanFace, ScanLine, TriangleAlert } from "lucide-react";
import { METHOD_INFO, TOKEN_ORDER } from "../data";
import { fmtToken, fmtUsd } from "../lib/format";
import { methodToCard } from "../lib/cards";
import { NETWORK_NAME } from "../lib/wc/config";
import { useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { IconButton, ListRow, Pill, SectionHeader, SubHeading, TokenIcon, TopBar, focusRing } from "../components/ui";
import { TxRow } from "../components/TxRow";
import { CardHolder, HolderChip, HolderRow, HolderTitle, cardCountLabel } from "../components/CardHolder";

export function Home({ nav }: { nav: Nav }) {
  const { state, toggleHide, refresh } = useStore();
  const now = useNow(60_000);
  // All three tokens are dollar stablecoins (tUSDT is a test dollar), so the total is their sum.
  const total = TOKEN_ORDER.reduce((n, t) => n + state.wallet.balances[t], 0);
  const activeMethodNames = state.cards.filter((c) => c.activeAt <= now).map((c) => METHOD_INFO[c.kind].name);

  return (
    <>
      <TopBar
        right={
          <>
            {state.pending.length > 0 && (
              <Pill tone="accent" icon={Hourglass} onClick={() => nav.goTab("payments")}>
                {state.pending.length} pending
              </Pill>
            )}
            <Pill trailingIcon={Plus} onClick={() => nav.openSheet({ type: "more" })}>
              Do more
            </Pill>
          </>
        }
      />

      {state.error && (
        <div className="mx-5 mb-3 flex items-start gap-3 rounded-[20px] bg-danger-soft p-3.5" role="alert">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <p className="min-w-0 flex-1 text-sm leading-snug text-ink">Could not read {NETWORK_NAME}: {state.error}</p>
          <button
            type="button"
            onClick={refresh}
            aria-label="Try again"
            className={`grid size-8 shrink-0 place-items-center rounded-full bg-white/70 hover:bg-white ${focusRing}`}
          >
            <RefreshCw className="size-4" aria-hidden />
          </button>
        </div>
      )}

      {/* Balance */}
      <section className="px-5" aria-labelledby="balance-label">
        <p id="balance-label" className="text-[15px] text-ink-2">
          Total balance · {NETWORK_NAME}
        </p>
        <div className="mt-0.5 flex items-center gap-1">
          <p className="mr-2 text-[2rem] font-bold tabular-nums tracking-tight">
            {state.hideBalance ? "••••••" : fmtUsd(total)}
          </p>
          <IconButton label={state.hideBalance ? "Show balance" : "Hide balance"} icon={state.hideBalance ? Eye : EyeOff} onClick={toggleHide} />
          <IconButton label="Spending limits" icon={ChartNoAxesColumn} onClick={() => nav.openSub("limits")} />
        </div>
      </section>

      {/* Quick actions */}
      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto px-5 pb-1">
        <button
          type="button"
          onClick={() => nav.openSheet({ type: "scan" })}
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-wave-deep px-4 text-base font-semibold text-white hover:bg-[#262626] active:scale-[0.97] ${focusRing}`}
        >
          <ScanLine className="size-[18px]" aria-hidden /> Scan
        </button>
        {(
          [
            ["Send", () => nav.openSheet({ type: "send" })],
            ["Add money", () => nav.openSheet({ type: "receive" })],
          ] as const
        ).map(([label, fn]) => (
          <button
            key={label}
            type="button"
            onClick={fn}
            className={`inline-flex h-11 shrink-0 items-center rounded-full bg-wave-soft px-4 text-base font-semibold hover:bg-[#e2e2e2] active:scale-[0.97] ${focusRing}`}
          >
            {label}
          </button>
        ))}
      </div>

      <WalletHolder nav={nav} />

      {/* Transactions */}
      <section className="mt-8" aria-labelledby="tx-title">
        <SectionHeader
          action={
            <button
              type="button"
              onClick={() => nav.goTab("payments")}
              className={`rounded text-[15px] font-semibold text-wave-deep underline underline-offset-4 ${focusRing}`}
            >
              See all
            </button>
          }
        >
          <span id="tx-title">Transactions</span>
        </SectionHeader>
        {state.transactions.length === 0 ? (
          <p className="px-5 py-6 text-[15px] text-muted">No transactions yet. Add money to get started.</p>
        ) : (
          <ul>
            {state.transactions.slice(0, 4).map((tx) => (
              <TxRow key={tx.id} tx={tx} />
            ))}
          </ul>
        )}
      </section>

      {/* Manage */}
      <section className="mt-8" aria-label="Manage wallet">
        <SubHeading>Manage wallet</SubHeading>
        <div className="mt-2 space-y-0.5">
          <ListRow icon={List} label="View all activity" onClick={() => nav.goTab("payments")} />
          <ListRow icon={ScanFace} label="Approval methods" hint={activeMethodNames.join(", ")} onClick={() => nav.openSub("methods")} />
          <ListRow icon={Gauge} label="Your spending limits" onClick={() => nav.openSub("limits")} />
          <ListRow
            icon={Hourglass}
            label="Pending actions"
            hint={state.pending.length ? `${state.pending.length} waiting in the delay queue` : "Nothing waiting"}
            onClick={() => nav.goTab("payments")}
          />
          <ListRow icon={Landmark} label="Account details" onClick={() => nav.openSub("account")} />
        </div>
      </section>
    </>
  );
}

/** The wallet holder. Its cards are the approval methods; on Whitechain that is the owner passkey. */
function WalletHolder({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const now = useNow(60_000);
  const methodCards = state.cards.map((c) => methodToCard(c, now));

  return (
    <div className="mt-5 px-5">
      <CardHolder
        ariaLabel={state.wallet.name}
        cards={methodCards}
        frontLabel={cardCountLabel(methodCards.length, "method")}
        emptyLabel="Add an approval method"
        newCardId={state.newCardId}
        onOpenCards={() => nav.openSheet({ type: "cards", holder: "methods" })}
        onCreate={() => nav.openSheet({ type: "createCard" })}
      >
        <HolderTitle onClick={() => nav.openSub("account")}>{state.wallet.name}</HolderTitle>
        <ul className="mt-3">
          {TOKEN_ORDER.map((t) => (
            <li key={t}>
              <HolderRow lead={<TokenIcon token={t} />} onClick={() => nav.openSub("account")}>
                {state.hideBalance ? "••••" : fmtToken(state.wallet.balances[t], t)}
              </HolderRow>
            </li>
          ))}
        </ul>
        <HolderChip icon={Landmark} onClick={() => nav.openSub("account")}>
          Account details
        </HolderChip>
      </CardHolder>
    </div>
  );
}
