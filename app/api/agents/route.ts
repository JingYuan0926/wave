import type { AgentsResponse } from "@/lib/api-types";
import { readAgents } from "@/lib/server/agents";
import { queryParam, requireLocalHost, route } from "@/lib/server/http";

// The list holds the checkpoint amounts and the waiting actions, so a tunnel must not reach it.
export const GET = route(async (request): Promise<AgentsResponse> => {
  requireLocalHost(request);
  return readAgents(queryParam(request, "master"));
});
