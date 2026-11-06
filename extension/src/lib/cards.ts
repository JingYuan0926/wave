import { Bot } from "lucide-react";
import { METHOD_INFO, type Agent, type MethodCard } from "../data";
import { METHOD_KIND_ICON, type HolderCard } from "../components/CardHolder";

export function methodToCard(c: MethodCard, now: number): HolderCard {
  const hours = Math.max(0, Math.ceil((c.activeAt - now) / 3_600_000));
  return {
    id: c.id,
    design: c.design,
    title: METHOD_INFO[c.kind].name,
    subtitle: METHOD_INFO[c.kind].approves,
    icon: METHOD_KIND_ICON[c.kind],
    pendingLabel: hours > 0 ? `Active in ${hours}h` : undefined,
  };
}

export function agentToCard(a: Agent): HolderCard {
  return {
    id: a.id,
    design: a.design,
    title: a.name,
    subtitle: `${a.limit} USDC a ${a.per}`,
    icon: Bot,
    pendingLabel: a.active ? undefined : "Paused",
  };
}
