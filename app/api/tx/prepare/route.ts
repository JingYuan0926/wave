import type { TxPrepareRequest, TxPrepareResponse } from "@/lib/api-types";
import { readBody, route } from "@/lib/server/http";
import { prepareTx } from "@/lib/server/prepare";

export const POST = route(
  async (request): Promise<TxPrepareResponse> => prepareTx(await readBody<TxPrepareRequest>(request)),
);
