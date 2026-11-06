import type { WorldRpContextRequest, WorldRpContextResponse } from "@/lib/api-types";
import { WORLD_ACTION } from "@/lib/api-types";
import { ApiFailure, readBody, route } from "@/lib/server/http";
import { rpContext } from "@/lib/server/world-config";

export const POST = route(async (request): Promise<WorldRpContextResponse> => {
  const body = await readBody<WorldRpContextRequest>(request);
  if (body.action !== WORLD_ACTION) throw new ApiFailure("BAD_REQUEST", "WAVE signs one action only.");
  return rpContext();
});
