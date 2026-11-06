import { Hourglass, Plus, ShieldAlert } from "lucide-react";
import { METHOD_LABEL } from "../data";
import { fmtCountdown } from "../lib/format";
import { useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { PageTitle, Pill, SectionHeader, TopBar, focusRing } from "../components/ui";
import { TxRow } from "../components/TxRow";

export function Payments({ nav }: { nav: Nav }) {
  const { state, removePending, addTx, debit, activateCard } = useStore();
  const now = useNow(1000);

  const runNow = (id: string) => {
    const p = state.pending.find((x) => x.id === id);
    if (!p) return;
    removePending(id);
    if (p.cardId) activateCard(p.cardId);
    if (p.transfer) {
      debit(p.transfer.token, p.transfer.amount);
      addTx({
        kind: "out",
        title: `To ${p.transfer.to}`,
        subtitle: `${METHOD_LABEL[p.proposedBy]} · after delay · Just now`,
        amount: p.transfer.amount,
        token: p.transfer.token,
        method: p.proposedBy,
      });
    } else {
      addTx({ kind: "config", title: p.title, subtitle: `${METHOD_LABEL[p.proposedBy]} · after delay · Just now` });
    }
  };

  return (
    <>
      <TopBar
        right={
          <Pill tone="accent" trailingIcon={Plus} onClick={() => nav.openSheet({ type: "send" })}>
            Send
          </Pill>
        }
      />
      <PageTitle>Payments</PageTitle>

      <section aria-labelledby="queue-title">
        <div className="px-5">
          <h2 id="queue-title" className="text-lg font-bold">
            Waiting in the delay queue
          </h2>
          <p className="mt-1 text-[15px] leading-snug text-muted">
            Sensitive actions wait here before they run. Cancel anything you don't recognise.
          </p>
        </div>

        {state.pending.length === 0 ? (
          <div className="mx-5 mt-4 flex flex-col items-center rounded-[24px] border border-dashed border-line px-6 py-8 text-center">
            <Hourglass className="size-7 text-muted" aria-hidden />
            <p className="mt-3 font-semibold">Nothing waiting</p>
            <p className="mt-1 text-sm text-muted">Large transfers and permission changes show up here.</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3 px-5">
            {state.pending.map((p) => {
              const left = p.endsAt - now;
              const ready = left <= 0;
              return (
                <li key={p.id} className="rounded-[24px] bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[17px] font-bold">{p.title}</p>
                      <p className="mt-0.5 text-sm text-muted">{p.detail}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums ${
                        ready ? "bg-wave text-ink" : "bg-warn-soft text-warn"
                      }`}
                    >
                      {fmtCountdown(left)}
                    </span>
                  </div>
                  <p className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-2">
                    <ShieldAlert className="size-4" aria-hidden />
                    Proposed with {METHOD_LABEL[p.proposedBy]}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => nav.openSheet({ type: "cancel", pendingId: p.id })}
                      className={`h-11 flex-1 rounded-full border border-ink/15 bg-white text-[15px] font-semibold hover:bg-surface-2 ${focusRing}`}
                    >
                      Cancel
                    </button>
                    {ready && (
                      <button
                        type="button"
                        onClick={() => runNow(p.id)}
                        className={`h-11 flex-1 rounded-full bg-wave-deep text-[15px] font-semibold text-white hover:bg-[#222626] ${focusRing}`}
                      >
                        Run now
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="activity-title">
        <SectionHeader>
          <span id="activity-title">Activity</span>
        </SectionHeader>
        {state.transactions.length === 0 ? (
          <p className="px-5 py-6 text-[15px] text-muted">No activity yet.</p>
        ) : (
          <ul>
            {state.transactions.map((tx) => (
              <TxRow key={tx.id} tx={tx} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
