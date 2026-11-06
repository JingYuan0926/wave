import type { TxSendRequest, TxSendResponse } from "@/lib/api-types";
import { readBody, route } from "@/lib/server/http";
import { sendTx } from "@/lib/server/send";

export const POST = route(
  async (request): Promise<TxSendResponse> => sendTx(await readBody<TxSendRequest>(request)),
);
