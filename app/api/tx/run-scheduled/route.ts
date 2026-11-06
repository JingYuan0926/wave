import { encodeFunctionData } from "viem";
import type { RunScheduledRequest, RunScheduledResponse } from "@/lib/api-types";
import { LEGACY_TX, NETWORK, devWallet, publicClient } from "@/lib/chain";
import { ApiFailure, asAddress, asHex, deployment, readBody, requireLocal, route } from "@/lib/server/http";
import { queuedSource } from "@/lib/server/pending";
import { checkRunnable } from "@/lib/server/prepare";
import { withDevKey } from "@/lib/server/roots";
import { WaveAccountAbi } from "@/lib/wave-abi";

// A queued action can install a method or write many tiers, and each new slot costs state gas.
const RUN_GAS = BigInt(8_000_000);

/**
 * Runs a queued action with no new approval. The owner approved it when it was queued.
 * executeScheduled is open to any caller, and the contract checks the delay and the stored action.
 */
export const POST = route(async (request): Promise<RunScheduledResponse> => {
  requireLocal(request);
  if (NETWORK !== "local") {
    throw new ApiFailure("LOCAL_ONLY", "The server runs queued actions on the local network only.", 409);
  }
  const body = await readBody<RunScheduledRequest>(request);
  const account = asAddress(body.account, "account");
  const id = asHex(body.actionId, "actionId", 32);
  const d = deployment();

  const source = await queuedSource(d, account, id);
  if (!source) throw new ApiFailure("NOT_SCHEDULED", "This action is not in the queue.", 404);
  const refused = await checkRunnable({ d, account }, id, source.batch);
  if (refused) throw new ApiFailure(refused.code, `The contract refused this action: ${refused.code}.`, 409);

  const data = encodeFunctionData({
    abi: WaveAccountAbi,
    functionName: "executeScheduled",
    args: [id, source.batch],
  });
  const txHash = await withDevKey(async () => {
    const hash = await devWallet.sendTransaction({ to: account, data, gas: RUN_GAS, ...LEGACY_TX });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") {
      throw new ApiFailure("RUN_FAILED", `The queued action reverted in ${hash}.`, 500);
    }
    return hash;
  });
  return { txHash };
});
