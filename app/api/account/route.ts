import type { AccountResponse } from "@/lib/api-types";
import { readAccount } from "@/lib/server/account-view";
import { asAddress, deployment, queryParam, route } from "@/lib/server/http";

export const GET = route(
  async (request): Promise<AccountResponse> =>
    readAccount(deployment(), asAddress(queryParam(request, "address"))),
);
