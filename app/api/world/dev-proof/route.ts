import { existsSync } from "node:fs";
import path from "node:path";
import { encodeAbiParameters, numberToHex, toHex, type Hex } from "viem";
import type { WorldDevProofRequest, WorldDevProofResponse } from "@/lib/api-types";
import { ApiFailure, asHex, asWord, readBody, route } from "@/lib/server/http";
import { externalNullifier, signalHashOf, worldConfig } from "@/lib/server/world-config";
import { proveDev } from "@/lib/world-dev";

const PROOF_WORDS = [{ type: "uint256[8]" }] as const;

export const POST = route(async (request): Promise<WorldDevProofResponse> => {
  if (worldConfig().mode !== "dev") {
    throw new ApiFailure("NOT_DEV_MODE", "This server uses real World ID, not test identities.");
  }
  if (!existsSync(path.join(process.cwd(), "scripts/.zk/semaphore.zkey"))) {
    throw new ApiFailure("ZK_FILES_MISSING", "Run scripts/fetch-zk.sh to download the circuit files.", 503);
  }
  const { identity, signal } = await readBody<WorldDevProofRequest>(request);
  if (typeof signal !== "string" || signal.length === 0) {
    throw new ApiFailure("BAD_REQUEST", "The request needs a signal.");
  }
  const id = {
    trapdoor: BigInt(asWord(identity?.trapdoor, "trapdoor")),
    nullifier: BigInt(asWord(identity?.nullifier, "nullifier")),
  };
  const signalBytes: Hex = signal.startsWith("0x") ? asHex(signal, "signal") : toHex(signal);
  const proof = await proveDev(id, externalNullifier(), signalBytes);
  return {
    proof: encodeAbiParameters(PROOF_WORDS, [proof.proof as never]),
    merkleRoot: numberToHex(proof.root, { size: 32 }),
    nullifierHash: numberToHex(proof.nullifierHash, { size: 32 }),
    signalHash: numberToHex(signalHashOf(signal), { size: 32 }),
  };
});
