import type { AgentConfirmTokenRequest, AgentConfirmTokenResponse } from "@/lib/api-types";
import { issueConfirmToken } from "@/lib/server/agents";
import { readBody, requirePage, route } from "@/lib/server/http";

// /agents and /wallet ask for this when a person presses Confirm. No MCP tool calls this route.
export const POST = route(async (request): Promise<AgentConfirmTokenResponse> => {
  requirePage(request);
  const { operationId } = await readBody<AgentConfirmTokenRequest>(request);
  return issueConfirmToken(operationId);
});
