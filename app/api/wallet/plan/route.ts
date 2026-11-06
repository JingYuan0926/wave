import type { WalletPlanResponse } from "@/lib/api-types";
import { deployment, readBody, route } from "@/lib/server/http";
import { planResponse } from "@/lib/server/wallet-plan";

/** Turns the ticked methods into a wallet address. It sends nothing to the chain. */
export const POST = route(
  async (request): Promise<WalletPlanResponse> => planResponse(deployment(), await readBody<unknown>(request)),
);
