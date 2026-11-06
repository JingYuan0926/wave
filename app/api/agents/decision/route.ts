import type { AgentDecisionRequest, AgentOperationView } from "@/lib/api-types";
import { decideOperation } from "@/lib/server/agents";
import { readBody, requirePage, route } from "@/lib/server/http";

// This sends the agent's payment. A person must press Confirm on the /agents page: the route needs
// the headers of that page and a one-use token. No MCP tool calls this route. A local program can
// copy the headers and ask for a token, so the person who runs this server must trust that computer.
export const POST = route(async (request): Promise<AgentOperationView> => {
  requirePage(request);
  return decideOperation(await readBody<AgentDecisionRequest>(request));
});
