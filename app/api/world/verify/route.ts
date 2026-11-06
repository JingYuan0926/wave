import { after } from "next/server";
import { decodeAbiParameters, numberToHex } from "viem";
import type { WorldProof, WorldVerifyRequest, WorldVerifyResponse } from "@/lib/api-types";
import { ApiFailure, asHex, deployment, readBody, route } from "@/lib/server/http";
import { referenceFor } from "@/lib/server/roots";
import { plannedWallet } from "@/lib/server/wallet-plan";
import {
  checkProofOnchain,
  verifyWithPortal,
  worldConfig,
} from "@/lib/server/world-config";

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
  const ownerNullifierHash = numberToHex(BigInt(proof.nullifierHash), { size: 32 });
  const planned = await plannedWallet(d, { owner: { kind: "world", nullifierHash: ownerNullifierHash }, extras: [] });
  // Publish now, so the first World ID send does not wait for it. A failure here only costs that wait.
  after(() => referenceFor(proof.merkleRoot).catch((error) => console.error("[wave api] root publish", error)));
  return {
    ownerNullifierHash,
    merkleRoot: proof.merkleRoot,
    address: planned.address,
    salt: planned.frame.salt,
  };
});
