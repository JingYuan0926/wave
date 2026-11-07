import { Bot } from "lucide-react";
import { METHOD_INFO, type Agent, type MethodCard } from "../data";
import { METHOD_KIND_ICON, type HolderCard } from "../components/CardHolder";

/** The real name of a method card, or the sample name of a preview card. */
export const methodName = (c: MethodCard) => c.title ?? METHOD_INFO[c.kind].name;

/** The state text of a queued method. A live method has none. */
export function methodWait(c: MethodCard, now: number): string | undefined {
  if (!c.queued) return undefined;
  const left = c.activeAt - now;
  if (!Number.isFinite(left)) return "Queued";
  // The delay is over, but the method cannot approve until the action runs.
  if (left <= 0) return "Ready to run";
  const minutes = Math.ceil(left / 60_000);
  return minutes < 60 ? `Active in ${minutes}m` : `Active in ${Math.ceil(minutes / 60)}h`;
}

export function methodToCard(c: MethodCard, now: number): HolderCard {
  return {
    id: c.id,
    design: c.design,
    title: methodName(c),
    subtitle: c.subtitle ?? METHOD_INFO[c.kind].approves,
    icon: METHOD_KIND_ICON[c.kind],
    pendingLabel: methodWait(c, now),
  };
}

export function agentToCard(a: Agent): HolderCard {
  return {
    id: a.id,
    design: a.design,
    title: a.name,
    subtitle: a.limit > 0 ? `${a.limit} USDC a ${a.per}` : "No limits set",
    icon: Bot,
    pendingLabel: a.state === "active" ? undefined : a.state === "paused" ? "Paused" : "Revoked",
  };
}
