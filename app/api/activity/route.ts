import type { ActivityResponse } from "@/lib/api-types";
import { readActivity } from "@/lib/server/activity";
import { asAddress, deployment, queryParam, route } from "@/lib/server/http";

export const GET = route(async (request): Promise<ActivityResponse> => ({
  items: await readActivity(deployment(), asAddress(queryParam(request, "address"))),
}));
