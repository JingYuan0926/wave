import { useState } from "react";
import { Hourglass, Plus, ShieldAlert } from "lucide-react";
import { METHOD_LABEL } from "../data";
import { fmtCountdown } from "../lib/format";
import { runPending } from "../lib/wc/wallet";
import { useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { PageTitle, Pill, SectionHeader, TopBar, focusRing } from "../components/ui";
import { TxRow } from "../components/TxRow";

export function Payments({ nav }: { nav: Nav }) {
  const { state, removePending, refresh } = useStore();
  const now = useNow(1000);
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<{ id: string; msg: string } | null>(null);

  /** After the delay, the passkey signs executeScheduled. The account checks the delay itself. */
  const runNow = async (id: string) => {
    const p = state.pending.find((x) => x.id === id);
    if (!p || !state.passkey) return;
    setRunning(id);
    setRunError(null);
    try {
      const r = await runPending(state.passkey, p.id, p.batch);
      if (!r.success) throw new Error("The wallet refused to run it. Its rules may have changed.");
      removePending(id);
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRunError({ id, msg: /NotAllowedError|aborted|cancel/i.test(msg) ? "The passkey prompt was closed." : msg });
    } finally {
      setRunning(null);
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
                        disabled={running !== null}
                        className={`h-11 flex-1 rounded-full bg-wave-deep text-[15px] font-semibold text-white hover:bg-[#262626] disabled:opacity-50 ${focusRing}`}
                      >
                        {running === p.id ? "Running…" : "Run now"}
                      </button>
                    )}
                  </div>
                  {runError?.id === p.id && running === null && (
                    <p role="alert" className="mt-2 text-sm font-semibold text-danger">
                      {runError.msg}
                    </p>
                  )}
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
