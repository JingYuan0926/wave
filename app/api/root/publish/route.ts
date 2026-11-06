import type { RootPublishRequest, RootPublishResponse } from "@/lib/api-types";
import { ApiFailure, asWord, readBody, requireLocal, route } from "@/lib/server/http";
import { publish } from "@/lib/server/roots";
import { latestWorldRoot, worldConfig } from "@/lib/server/world-config";

export const POST = route(async (request): Promise<RootPublishResponse> => {
  requireLocal(request);
  const body = await readBody<RootPublishRequest>(request);
  const world = worldConfig();
  let root = body.root ? asWord(body.root, "root") : null;
  if (!root) {
    if (world.mode !== "idkit") {
      throw new ApiFailure("NO_ROOT", "A test identity has its own root. The request needs `root`.");
    }
    root = await latestWorldRoot(world.environment);
  }
  const published = await publish(root);
  return {
    root: published.root,
    sourceId: published.sourceId,
    slot: published.slot.toString(),
    txHash: published.txHash,
  };
});
