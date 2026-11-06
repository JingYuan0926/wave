import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChartNoAxesColumn,
  Eye,
  EyeOff,
  Gauge,
  Hourglass,
  Landmark,
  LifeBuoy,
  List,
  Plus,
  ScanFace,
  ScanLine,
  Settings2,
  ShieldPlus,
  X,
} from "lucide-react";
import { ETH_USD, METHOD_INFO } from "../data";
import { fmtToken, fmtUsd } from "../lib/format";
import { agentToCard, methodToCard } from "../lib/cards";
import { useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { IconButton, ListRow, Pill, PrimaryButton, SectionHeader, SubHeading, TokenIcon, TopBar, focusRing } from "../components/ui";
import { TxRow } from "../components/TxRow";
import { CardHolder, HolderChip, HolderRow, HolderTitle, cardCountLabel } from "../components/CardHolder";

export function Home({ nav }: { nav: Nav }) {
  const { state, toggleHide, dismissPromo } = useStore();
  const now = useNow(60_000);
  const total = state.wallet.balances.USDC + state.wallet.balances.ETH * ETH_USD;

  // Recovery needs two methods besides World ID.
  const backups = state.cards.filter((c) => c.kind !== "worldid" && c.activeAt <= now).length;
  const backupsPending = state.cards.filter((c) => c.kind !== "worldid" && c.activeAt > now).length;
  const activeMethodNames = state.cards
    .filter((c) => c.activeAt <= now)
    .map((c) => METHOD_INFO[c.kind].name.replace(" passkey", ""));

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

      {/* Balance */}
      <section className="px-5" aria-labelledby="balance-label">
        <p id="balance-label" className="text-[15px] text-ink-2">
          Total balance
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
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-wave px-4 text-base font-semibold hover:brightness-95 active:scale-[0.97] ${focusRing}`}
        >
          <ScanLine className="size-[18px]" aria-hidden /> Scan
        </button>
        {(
          [
            ["Send", () => nav.openSheet({ type: "send" })],
            ["Add money", () => nav.openSheet({ type: "receive" })],
            ["Request", () => nav.openSheet({ type: "receive" })],
          ] as const
        ).map(([label, fn]) => (
          <button
            key={label}
            type="button"
            onClick={fn}
            className={`inline-flex h-11 shrink-0 items-center rounded-full bg-wave-soft px-4 text-base font-semibold hover:bg-[#cdf0f3] active:scale-[0.97] ${focusRing}`}
          >
            {label}
          </button>
        ))}
      </div>

      <HolderCarousel nav={nav} />

      {!state.promoDismissed && backups + backupsPending < 2 && (
        <section className="relative mx-5 mt-6 rounded-[24px] bg-wave-mist p-5" aria-labelledby="promo-title">
          <button
            type="button"
            onClick={dismissPromo}
            aria-label="Dismiss"
            className={`absolute right-3 top-3 grid size-9 place-items-center rounded-full bg-white/70 hover:bg-white ${focusRing}`}
          >
            <X className="size-4" aria-hidden />
          </button>
          <div className="flex gap-4 pr-6">
            <span className="grid size-12 shrink-0 place-items-center rounded-full border border-ink/15 bg-white/60" aria-hidden>
              <ShieldPlus className="size-[22px]" strokeWidth={1.8} />
            </span>
            <div>
              <h2 id="promo-title" className="text-[17px] font-bold">
                Get recovery ready
              </h2>
              <p className="mt-1 text-[15px] leading-snug text-ink-2">
                If you lose World ID, two other methods can recover your wallet. You have {backups + backupsPending}.
              </p>
            </div>
          </div>
          <div className="mt-4">
            <PrimaryButton onClick={() => nav.openSheet({ type: "createCard" })}>Add a backup method</PrimaryButton>
          </div>
        </section>
      )}

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
          <ListRow
            icon={LifeBuoy}
            label="Recovery"
            hint={backups >= 2 ? "Ready" : `Not ready · ${backups} of 2 backup methods`}
            onClick={() => nav.openSub("methods")}
          />
          <ListRow icon={Landmark} label="Account details" onClick={() => nav.openSub("account")} />
        </div>
      </section>
    </>
  );
}

function HolderCarousel({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const now = useNow(60_000);
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  const step = () => {
    const first = ref.current?.firstElementChild as HTMLElement | null;
    return first ? first.offsetWidth + 12 : 1;
  };
  const onScroll = () => {
    if (ref.current) setIndex(Math.round(ref.current.scrollLeft / step()));
  };

  // When a card is added, slide the carousel to the holder it went into.
  const { newCardId } = state;
  const isAgentCard = state.agents.some((a) => a.id === newCardId);
  useEffect(() => {
    if (!newCardId) return;
    ref.current?.scrollTo({ left: (isAgentCard ? 1 : 0) * step(), behavior: "smooth" });
  }, [newCardId, isAgentCard]);

  const methodCards = state.cards.map((c) => methodToCard(c, now));
  const agentCards = state.agents.map(agentToCard);
  const activeAgents = state.agents.filter((a) => a.active);
  const agentSpend = activeAgents.reduce((n, a) => n + a.used, 0);

  return (
    <div className="mt-5">
      <div ref={ref} onScroll={onScroll} className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-5 px-5">
        {/* Holder 1: the wallet. Its cards are your approval methods. */}
        <div className="w-[86%] shrink-0 snap-start">
          <CardHolder
            ariaLabel={state.wallet.name}
            cards={methodCards}
            frontLabel={cardCountLabel(methodCards.length, "method")}
            emptyLabel="Add an approval method"
            newCardId={newCardId}
            onOpenCards={() => nav.openSheet({ type: "cards", holder: "methods" })}
            onCreate={() => nav.openSheet({ type: "createCard" })}
          >
            <HolderTitle onClick={() => nav.openSub("account")}>{state.wallet.name}</HolderTitle>
            <ul className="mt-3">
              {(["USDC", "ETH"] as const).map((t) => (
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

        {/* Holder 2: agent budgets. Each card is one agent's spending budget. */}
        <div className="w-[86%] shrink-0 snap-start">
          <CardHolder
            ariaLabel="Agent budgets"
            cards={agentCards}
            frontLabel={cardCountLabel(agentCards.length, "budget")}
            emptyLabel="Give an agent a budget"
            newCardId={newCardId}
            onOpenCards={() => nav.openSheet({ type: "cards", holder: "agents" })}
            onCreate={() => nav.openSheet({ type: "addAgent" })}
          >
            <HolderTitle onClick={() => nav.goTab("agents")}>Agent budgets</HolderTitle>
            <ul className="mt-3">
              <li>
                <HolderRow
                  lead={
                    <span className="grid size-8 place-items-center rounded-full bg-wave text-ink" aria-hidden>
                      <Bot className="size-4" />
                    </span>
                  }
                  onClick={() => nav.goTab("agents")}
                >
                  {activeAgents.length} active {activeAgents.length === 1 ? "agent" : "agents"}
                </HolderRow>
              </li>
              <li>
                <HolderRow lead={<TokenIcon token="USDC" />} onClick={() => nav.goTab("agents")}>
                  {state.hideBalance ? "••••" : `${fmtToken(agentSpend, "USDC")} spent`}
                </HolderRow>
              </li>
            </ul>
            <HolderChip icon={Settings2} onClick={() => nav.goTab("agents")}>
              Manage agents
            </HolderChip>
          </CardHolder>
        </div>
      </div>
      <div className="mt-3 flex justify-center gap-1.5" aria-hidden>
        {[0, 1].map((i) => (
          <span key={i} className={`size-2 rounded-full transition-colors ${i === index ? "bg-ink" : "bg-line"}`} />
        ))}
      </div>
    </div>
  );
}
