import type { AgentOperationView, AgentPassDeviceRequest } from "@/lib/api-types";
import { startDeviceApproval } from "@/lib/server/agents";
import { readBody, requireLocal, route } from "@/lib/server/http";

// The response holds the user code, so a tunnel must not reach it. It never holds the device code.
export const POST = route(async (request): Promise<AgentOperationView> => {
  requireLocal(request);
  const { operationId } = await readBody<AgentPassDeviceRequest>(request);
  return startDeviceApproval(operationId);
});
