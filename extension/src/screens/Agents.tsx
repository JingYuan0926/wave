import { Bot, Clock, Plus, Terminal } from "lucide-react";
import { api, explorerTxUrl, isWaiting, operationsOf, type Address } from "../lib/wave";
import { useStore } from "../store";
import { fmtToken } from "../lib/format";
import type { Nav } from "../nav";
import { AgentLimit } from "../components/AgentLimit";
import { PageTitle, Pill, Switch, TopBar, focusRing } from "../components/ui";

export function Agents({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const { agentData: data } = state;


  /** The explorer has no address page, so this opens the latest transaction, or the home page. */
  const openInExplorer = (address: string) => {
    const { info } = state;
    if (!info) return;
    // A browser blocks a new tab that opens after a wait, so the tab opens first.
    const tab = window.open("about:blank", "_blank");
    if (!tab) return;
    tab.opener = null;
    api
      .activity(address as Address)
      .then(({ items }) => {
        tab.location.href = items[0] ? explorerTxUrl(info, items[0].txHash) : info.explorerUrl;
      })
      .catch(() => {
        tab.location.href = info.explorerUrl;
      });
  };

  return (
    <>
      <TopBar
        right={
          <Pill tone="accent" trailingIcon={Plus} onClick={() => nav.openSheet({ type: "addAgent" })}>
            Add agent
          </Pill>
        }
      />
      <PageTitle sub="AI agents can pay for you, inside the limits you set here.">Agents</PageTitle>


      {data && !data.agentKey && (
        <p className="mx-5 mt-3 rounded-[20px] bg-warn-soft p-4 text-sm leading-snug text-ink-2">
          The agent key is not set, so agents cannot spend. Set WAVE_AGENT_DEMO_KEY, then restart the server.
        </p>
      )}
      {data && !data.agentPassConfigured && (
        <p className="mx-5 mt-3 rounded-[20px] bg-warn-soft p-4 text-sm leading-snug text-ink-2">
          Agent Pass is not configured. Payments above the alone amount stay blocked.
        </p>
      )}

      {state.agents.length === 0 ? (
        <div className="mx-5 mt-6 flex flex-col items-center rounded-[24px] border border-dashed border-line px-6 py-10 text-center">
          <Bot className="size-8 text-muted" aria-hidden />
          <p className="mt-3 font-semibold">
            {!data ? "Your agents have not loaded yet" : data.supported ? "No agents yet" : "This deployment has no agent wallets"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {!data
              ? "WAVE reads them from the chain."
              : data.supported
                ? "Create an agent wallet and it can pay for you."
                : "Deploy the contracts again to use agents."}
          </p>
        </div>
      ) : (
        <ul className="mt-5 space-y-3 px-5">
          {state.agents.map((a) => {
            const needsYou = operationsOf(data, a.id).some(isWaiting);
            const linked = data?.toolAgent?.toLowerCase() === a.id.toLowerCase();
            return (
              <li key={a.id} className="relative rounded-[24px] bg-surface p-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`grid size-12 shrink-0 place-items-center rounded-full ${a.active ? "bg-wave text-ink" : "bg-surface-2 text-muted"}`}
                    aria-hidden
                  >
                    <Bot className="size-[22px]" strokeWidth={1.9} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[17px] font-bold">{a.name}</p>
                    {/* This sits above the card button, so a press here does not open the sheet. */}
                    <button
                      type="button"
                      onClick={() => openInExplorer(a.id)}
                      aria-label={`Open ${a.name} in the explorer`}
                      className={`relative z-10 block max-w-full truncate rounded text-sm text-muted underline underline-offset-2 hover:text-ink ${focusRing}`}
                    >
                      {a.purpose}
                    </button>
                  </div>
                  {/* This sits above the card button, so a press here does not open the sheet. */}
                  {a.state !== "revoked" && (
                    <span className="relative z-10 flex">
                      <Switch
                        checked={a.active}
                        onChange={() => nav.openSheet({ type: "agentSwitch", agentId: a.id })}
                        label={`${a.name} active`}
                      />
                    </span>
                  )}
                </div>

                {linked && (
                  <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-wave-soft px-3 py-1.5 text-[13px] font-semibold text-wave-press">
                    <Terminal className="size-3.5" aria-hidden /> Claude Code uses this agent
                  </p>
                )}
                <div className="mt-3 flex items-baseline justify-between gap-3">
                  <span className="text-sm text-ink-2">Balance</span>
                  <span className="text-lg font-bold tabular-nums">{fmtToken(a.balance, "USDC")}</span>
                </div>
                <div className="mt-3">
                  <AgentLimit agent={a} />
                </div>
                <div className="relative z-10 mt-3">
                  <button
                    type="button"
                    onClick={() => nav.openSheet({ type: "addressActivity", address: a.id, title: `${a.name} transactions` })}
                    className={`h-10 w-full rounded-full bg-white text-[15px] font-semibold ring-1 ring-line hover:bg-surface-2 ${focusRing}`}
                  >
                    Show transactions
                  </button>
                </div>
                {needsYou && (
                  <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-3 py-1.5 text-[13px] font-bold text-warn">
                    <Clock className="size-3.5" aria-hidden /> Needs your approval
                  </p>
                )}

                {/* The whole card is one button. A Switch inside a button would not be valid HTML. */}
                <button
                  type="button"
                  aria-label={needsYou ? `Open ${a.name}. It needs your approval.` : `Open ${a.name}`}
                  onClick={() => nav.openSheet({ type: "agent", agentId: a.id })}
                  className={`absolute inset-0 rounded-[24px] ${focusRing}`}
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="px-5 pt-5">
        <button
          type="button"
          onClick={() => nav.openSheet({ type: "addAgent" })}
          className={`flex h-14 w-full items-center justify-center gap-2 rounded-[20px] border border-dashed border-ink/20 text-[15px] font-semibold text-ink-2 hover:bg-surface ${focusRing}`}
        >
          <Plus className="size-5" aria-hidden /> Create an agent wallet
        </button>
      </div>
    </>
  );
}
