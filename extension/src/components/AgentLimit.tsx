import type { Agent } from "../data";
import { fmtToken } from "../lib/format";
import { Meter } from "./ui";

const PER_LABEL = { day: "today", week: "this week", month: "this month" } as const;
const STATE_LABEL = { active: "Active", paused: "Paused", revoked: "Revoked" } as const;

/** The limit of an agent: what it spent, its state, and what it can send. */
export function AgentLimit({ agent: a }: { agent: Agent }) {
  return (
    <>
      <div className="flex justify-between text-sm">
        <span className="text-ink-2">
          <span className="font-semibold tabular-nums text-ink">{fmtToken(a.used, "USDC").split(" ")[0]}</span> of{" "}
          {a.limit} USDC {PER_LABEL[a.per]}
        </span>
        <span className={`font-semibold ${a.active ? "text-positive" : "text-muted"}`}>
          {a.resumeQueued ? "Resume queued" : STATE_LABEL[a.state]}
        </span>
      </div>
      <Meter value={a.used} max={a.limit} label={`${a.name} daily limit used`} active={a.active} />
      <p className="mt-2 text-sm leading-snug text-muted">{a.sends}</p>
      {a.warning && <p className="mt-1 text-sm font-semibold leading-snug text-warn">{a.warning}</p>}
    </>
  );
}
