import type { ToolSendRequest, ToolSendResponse } from "@/lib/api-types";
import { sendFromTool } from "@/lib/server/agent-tools";
import { readBody, requireLocal, route } from "@/lib/server/http";

// This signs with the agent key on this server, so only a local caller can reach it.
export const POST = route(async (request): Promise<ToolSendResponse> => {
  requireLocal(request);
  return sendFromTool(await readBody<ToolSendRequest>(request));
});
