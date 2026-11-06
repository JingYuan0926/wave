import type { MethodId } from "../data";

/**
 * Asks the owner to approve with the given method.
 *
 * TODO: World ID → IDKit request in the World ID Simulator, with
 * signal = sig_hash. Face ID → WebAuthn assertion over sig_hash.
 * For now this waits and resolves so the UI flow can be reviewed.
 */
export async function requestApproval(method: MethodId): Promise<void> {
  const wait = method === "worldid" ? 2400 : 1300;
  await new Promise((r) => setTimeout(r, wait));
}

export const WORLD_ID_SIMULATOR_URL = "https://simulator.worldcoin.org";
