import { decodeAbiParameters, keccak256, numberToHex } from "viem";
import { cloneArgs } from "@/lib/account";
import type { WorldProof, WorldVerifyRequest, WorldVerifyResponse } from "@/lib/api-types";
import { publicClient } from "@/lib/chain";
import { ApiFailure, asHex, deployment, readBody, route } from "@/lib/server/http";
import { demoDelay } from "@/lib/server/prepare";
import {
  checkProofOnchain,
  externalNullifier,
  verifyWithPortal,
  worldConfig,
} from "@/lib/server/world-config";
import { WaveAccountFactoryAbi } from "@/lib/wave-abi";

const PROOF_WORDS = [{ type: "uint256[8]" }] as const;

async function checkedProof(body: WorldVerifyRequest): Promise<WorldProof> {
  if (body.source === "idkit") return verifyWithPortal(body.result);
  if (body.source !== "dev") throw new ApiFailure("BAD_REQUEST", "The proof source is not known.");
  if (worldConfig().mode !== "dev") {
    throw new ApiFailure("NOT_DEV_MODE", "This server uses real World ID, not test identities.");
  }
  const { proof } = body;
  const [words] = decodeAbiParameters(PROOF_WORDS, asHex(proof?.proof, "proof", 256));
  await checkProofOnchain(proof, words);
  return proof;
}

export const POST = route(async (request): Promise<WorldVerifyResponse> => {
  const proof = await checkedProof(await readBody<WorldVerifyRequest>(request));
  const d = deployment();
  const owner = BigInt(proof.nullifierHash);
  const ownerNullifierHash = numberToHex(owner, { size: 32 });
  // One human gets one address on this deployment, on every device.
  const salt = keccak256(ownerNullifierHash);
  const args = cloneArgs({
    worldIdValidator: d.worldIdValidator,
    ownerNullifierHash: owner,
    externalNullifierHash: externalNullifier(),
    rootSourceId: d.rootSourceId,
    demoDelay: demoDelay(),
  });
  const address = await publicClient.readContract({
    address: d.factory,
    abi: WaveAccountFactoryAbi,
    functionName: "predict",
    args: [d.implementation, args, salt],
  });
  return { ownerNullifierHash, merkleRoot: proof.merkleRoot, address, salt };
});
