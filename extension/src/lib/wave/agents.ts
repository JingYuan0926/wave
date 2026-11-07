import type { AgentOperationView, AgentsResponse } from "@/lib/api-types";

/** The same rule as components/agents/operations.tsx. Nothing in this state has run. */
export const isWaiting = ({ status }: AgentOperationView) => status === "needs-approval" || status === "needs-confirmation";

/** The requests of one agent wallet, newest first. */
export const operationsOf = (data: AgentsResponse | null, agent: string) =>
  (data?.operations ?? []).filter((operation) => operation.agent.toLowerCase() === agent.toLowerCase());
