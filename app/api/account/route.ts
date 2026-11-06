import type { AccountResponse } from "@/lib/api-types";
import { readAccount } from "@/lib/server/account-view";
import { ApiFailure, asAddress, deployment, queryParam, route } from "@/lib/server/http";
import { checkPlan } from "@/lib/server/wallet-plan";

function planOf(request: Request, d: ReturnType<typeof deployment>) {
  const text = new URL(request.url).searchParams.get("plan");
  if (!text) return undefined;
  try {
    return checkPlan(JSON.parse(text), d);
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure("BAD_REQUEST", "The plan is not JSON.");
  }
}

export const GET = route(async (request): Promise<AccountResponse> => {
  const d = deployment();
  return readAccount(d, asAddress(queryParam(request, "address")), planOf(request, d));
});
