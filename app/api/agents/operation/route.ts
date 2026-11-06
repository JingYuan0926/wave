import type { AgentOperationView } from "@/lib/api-types";
import { readOperation } from "@/lib/server/agents";
import { queryParam, requireLocalHost, route } from "@/lib/server/http";

// A read only: asking again never sends anything. The view holds the user code, so a tunnel must
// not reach it.
export const GET = route(async (request): Promise<AgentOperationView> => {
  requireLocalHost(request);
  return readOperation(queryParam(request, "id"));
});
