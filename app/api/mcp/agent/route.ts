import type { ToolAgentRequest, ToolAgentResponse } from "@/lib/api-types";
import { chooseToolAgent } from "@/lib/server/agents";
import { readToolAgentView } from "@/lib/server/agent-tools";
import { readBody, requireLocalHost, requirePage, route } from "@/lib/server/http";

// The MCP tools read the balance and the limits here, so a tunnel must not reach it.
export const GET = route(async (request): Promise<ToolAgentResponse> => {
  requireLocalHost(request);
  return readToolAgentView();
});

// The "Use with Claude Code" button. A tool cannot choose which wallet pays.
export const POST = route(async (request): Promise<{ agent: string }> => {
  requirePage(request);
  const { agent } = await readBody<ToolAgentRequest>(request);
  return { agent: await chooseToolAgent(agent) };
});
