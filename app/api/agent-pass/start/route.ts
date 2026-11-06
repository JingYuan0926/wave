import { AGENT_PASS_OPERATION, type AgentPassStartRequest, type AgentPassStartResponse } from "@/lib/api-types";
import { startAttempt } from "@/lib/server/agent-pass";
import { startOperation } from "@/lib/server/agents";
import { ApiFailure, asAddress, readBody, requireLocal, requireLocalHost, route } from "@/lib/server/http";

// An approval spends a server key, so only a local caller can start one.
export const POST = route(async (request): Promise<AgentPassStartResponse> => {
  requireLocal(request);
  const body = await readBody<AgentPassStartRequest>(request);
  if ("operationId" in body) {
    // The callback returns on the tunnel host. The browser goes back to the host that it came from.
    return startOperation(body.operationId, `http://${requireLocalHost(request)}/agents`);
  }
  const wallet = asAddress(body.wallet, "wallet");
  if (body.operation !== AGENT_PASS_OPERATION) {
    throw new ApiFailure("BAD_REQUEST", `operation must be ${AGENT_PASS_OPERATION}.`);
  }
  return startAttempt(wallet);
});
