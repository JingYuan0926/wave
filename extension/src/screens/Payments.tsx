import { useState } from "react";
import { Hourglass, Plus, ShieldAlert } from "lucide-react";
import { METHOD_LABEL, type Pending } from "../data";
import { fmtCountdown } from "../lib/format";
import { api, runErrorText, type Hex } from "../lib/wave";
import { useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { PageTitle, Pill, SectionHeader, TopBar, focusRing } from "../components/ui";
import { TxLink } from "../components/Approving";
import { TxRow } from "../components/TxRow";

function badgeText(p: Pending, ready: boolean, left: number) {
  if (p.status === "stale") return "Out of date";
  if (p.status === "needs-approval") return `${p.approvals} of 2 approvals`;
  return ready ? "Ready" : fmtCountdown(left);
}

function PendingRow({ p, now, nav, onRan }: { p: Pending; now: number; nav: Nav; onRan: (hash: Hex) => void }) {
  const { state, refresh } = useStore();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const left = p.endsAt - now;
  const ready = p.status === "ready" || (p.status === "waiting" && left <= 0);

  // The owner approved this when it was queued. So a sponsored network needs no new approval.
  const run = async () => {
    const wallet = state.localWallet;
    if (!state.info?.gasSponsored || !wallet) {
      nav.openSheet({ type: "run", pendingId: p.id });
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const { txHash } = await api.runScheduled({ account: wallet.address, actionId: p.id as Hex });
      onRan(txHash);
      await refresh();
    } catch (cause) {
      setRunError(runErrorText(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <li className="rounded-[24px] bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[17px] font-bold">{p.title}</p>
          <p className="mt-0.5 break-words text-sm text-muted">{p.detail}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums ${
            ready ? "bg-wave text-ink" : "bg-warn-soft text-warn"
          }`}
        >
          {badgeText(p, ready, left)}
        </span>
      </div>
      {p.warning && <p className="mt-2 text-sm leading-snug text-ink-2">{p.warning}</p>}
      {p.status === "stale" && (
        <p className="mt-2 text-sm leading-snug text-ink-2">
          The account configuration changed, so this action cannot run. Cancel it to clear this row.
        </p>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-2">
        <ShieldAlert className="size-4" aria-hidden />
        Proposed with {p.proposedName ?? METHOD_LABEL[p.proposedBy]}
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
            disabled={running}
            onClick={() => void run()}
            className={`h-11 flex-1 rounded-full bg-wave-deep text-[15px] font-semibold text-white hover:bg-wave-press disabled:opacity-60 ${focusRing}`}
          >
            {running ? "Running…" : "Run now"}
          </button>
        )}
      </div>
      {runError && (
        <p role="alert" className="mt-3 text-sm font-semibold leading-snug text-danger">
          {runError}
        </p>
      )}
    </li>
  );
}

export function Payments({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const now = useNow(1000);
  // The row leaves the queue after the run, so the hash stays here.
  const [ran, setRan] = useState<Hex | null>(null);

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
            {state.pending.map((p) => (
              <PendingRow key={p.id} p={p} now={now} nav={nav} onRan={setRan} />
            ))}
          </ul>
        )}

        {ran && (
          <div className="mx-5 mt-3 rounded-[20px] bg-wave-mist p-4" role="status">
            <p className="text-[15px] font-semibold">The action ran</p>
            <TxLink hash={ran} />
          </div>
        )}
      </section>

      <section className="mt-8" aria-labelledby="activity-title">
        <SectionHeader>
          <span id="activity-title">Activity</span>
        </SectionHeader>
        {state.transactions.length === 0 ? (
          <p className="px-5 py-6 text-[15px] text-muted">{state.account ? "No activity yet." : "Your activity has not loaded yet."}</p>
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
