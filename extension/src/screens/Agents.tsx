import { Bot, Plus, ShieldCheck } from "lucide-react";
import { useStore } from "../store";
import type { Nav } from "../nav";
import { PageTitle, Pill, TopBar, focusRing } from "../components/ui";

const PER_LABEL = { day: "today", week: "this week", month: "this month" } as const;

export function Agents({ nav }: { nav: Nav }) {
  const { state, toggleAgent } = useStore();

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

      <div className="mx-5 flex gap-3 rounded-[20px] bg-wave-mist p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-wave-deep" aria-hidden />
        <p className="text-sm leading-snug text-ink-2">
          Agents can't approve token permissions, add methods or change your rules. Anything above an agent's limit needs
          your approval.
        </p>
      </div>

      {state.agents.length === 0 ? (
        <div className="mx-5 mt-6 flex flex-col items-center rounded-[24px] border border-dashed border-line px-6 py-10 text-center">
          <Bot className="size-8 text-muted" aria-hidden />
          <p className="mt-3 font-semibold">No agents yet</p>
          <p className="mt-1 text-sm text-muted">Give an agent a budget and it can pay for you.</p>
        </div>
      ) : (
        <ul className="mt-5 space-y-3 px-5">
          {state.agents.map((a) => {
            const pct = Math.min(100, (a.used / a.limit) * 100);
            return (
              <li key={a.id} className="rounded-[24px] bg-surface p-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`grid size-12 shrink-0 place-items-center rounded-full ${a.active ? "bg-wave text-ink" : "bg-surface-2 text-muted"}`}
                    aria-hidden
                  >
                    <Bot className="size-[22px]" strokeWidth={1.9} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[17px] font-bold">{a.name}</p>
                    <p className="truncate text-sm text-muted">{a.purpose}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={a.active}
                    aria-label={`${a.name} ${a.active ? "active" : "paused"}`}
                    onClick={() => toggleAgent(a.id)}
                    className={`relative h-8 w-13 shrink-0 rounded-full transition-colors ${a.active ? "bg-wave-deep" : "bg-[#c8cdcd]"} ${focusRing}`}
                  >
                    <span
                      className={`absolute top-1 size-6 rounded-full bg-white shadow transition-transform ${a.active ? "translate-x-6" : "translate-x-1"}`}
                      aria-hidden
                    />
                  </button>
                </div>

                <div className="mt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-2">
                      <span className="font-semibold tabular-nums text-ink">{a.used.toFixed(2)}</span> of {a.limit} USDC{" "}
                      {PER_LABEL[a.per]}
                    </span>
                    <span className={`font-semibold ${a.active ? "text-positive" : "text-muted"}`}>
                      {a.active ? "Active" : "Paused"}
                    </span>
                  </div>
                  <div
                    className="mt-2 h-2 overflow-hidden rounded-full bg-white"
                    role="progressbar"
                    aria-label={`${a.name} budget used`}
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className={`h-full rounded-full ${a.active ? "bg-wave-deep" : "bg-[#c8cdcd]"}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
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
          <Plus className="size-5" aria-hidden /> Give a new agent a budget
        </button>
      </div>
    </>
  );
}
