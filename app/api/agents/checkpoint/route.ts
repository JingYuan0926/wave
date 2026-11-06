import type { AgentCheckpointRequest, AgentCheckpointResponse } from "@/lib/api-types";
import { setCheckpoint } from "@/lib/server/agents";
import { readBody, requireLocal, route } from "@/lib/server/http";

export const POST = route(async (request): Promise<AgentCheckpointResponse> => {
  requireLocal(request);
  return setCheckpoint(await readBody<AgentCheckpointRequest>(request));
});
