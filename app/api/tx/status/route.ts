import type { TxStatusResponse } from "@/lib/api-types";
import { asHex, queryParam, route } from "@/lib/server/http";
import { txStatus } from "@/lib/server/send";

export const GET = route(
  async (request): Promise<TxStatusResponse> => txStatus(asHex(queryParam(request, "hash"), "hash", 32)),
);
