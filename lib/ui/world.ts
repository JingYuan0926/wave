import type { Hex, WorldProof } from "@/lib/api-types";

type LegacyResponseItem = {
  proof?: unknown;
  merkle_root?: unknown;
  nullifier?: unknown;
  signal_hash?: unknown;
};

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && value.startsWith("0x");
}

/**
 * Read the 3.0 proof from an IDKit result. A 4.0 result has a `proof` array
 * and no `merkle_root`. The onchain verifier cannot use it.
 */
export function proofFromIdkit(result: unknown): WorldProof {
  const responses = (result as { responses?: LegacyResponseItem[] }).responses;
  const item = responses?.[0];
  if (!item || !isHex(item.proof) || !isHex(item.merkle_root) || !isHex(item.nullifier)) {
    throw new Error("World App did not return a 3.0 Orb proof. WAVE needs that proof.");
  }
  return {
    proof: item.proof,
    merkleRoot: item.merkle_root,
    nullifierHash: item.nullifier,
    signalHash: isHex(item.signal_hash) ? item.signal_hash : "0x",
  };
}

/** Roots can differ in hex case or padding. Compare the numbers. */
export function sameRoot(a: Hex, b: Hex): boolean {
  return BigInt(a) === BigInt(b);
}
