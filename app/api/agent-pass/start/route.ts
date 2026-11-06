import { AGENT_PASS_OPERATION, type AgentPassStartRequest, type AgentPassStartResponse } from "@/lib/api-types";
import { startAttempt } from "@/lib/server/agent-pass";
import { ApiFailure, asAddress, readBody, requireLocal, route } from "@/lib/server/http";

// The browser flow of the Settings test panel. An approval spends a server key, so only a local
// caller can start one. An agent action uses the device flow: see /api/agent-pass/device.
export const POST = route(async (request): Promise<AgentPassStartResponse> => {
  requireLocal(request);
  const body = await readBody<AgentPassStartRequest>(request);
  const wallet = asAddress(body.wallet, "wallet");
  if (body.operation !== AGENT_PASS_OPERATION) {
    throw new ApiFailure("BAD_REQUEST", `operation must be ${AGENT_PASS_OPERATION}.`);
  }
  return startAttempt(wallet);
});
