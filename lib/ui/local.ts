"use client";

import { useSyncExternalStore } from "react";
import type { Address, DevIdentity, Hex, PasskeySlot, WalletPlan } from "@/lib/api-types";

/**
 * Per-browser state. The chain holds the real state. This store keeps only
 * what the chain cannot give back: the wallet pointer, the local test identity
 * and the passkey credential IDs.
 */

export type LocalWallet = {
  address: Address;
  /** What the owner ticked. The first transaction deploys the wallet from this plan. */
  plan: WalletPlan;
  /** The last `merkle_root` seen. The next World ID tx references it. */
  rootHint: Hex | null;
};

export type PasskeyName = "passkey" | "security-key";

export type LocalPasskey = {
  credentialId: string;
  /** The chain sees one kind of key. This name exists only in this browser. */
  name?: PasskeyName;
};

export type LocalState = {
  wallet: LocalWallet | null;
  identity: DevIdentity | null;
  /** Test identities made for a recovery. Key: the nullifier hash as a decimal string. */
  recoveryIdentities: Record<string, DevIdentity>;
  /** Key: `${address}:${slot}`. */
  passkeys: Record<string, LocalPasskey>;
  /** New owner passkeys that wait for a recovery. Key: the public key x, in lowercase. */
  recoveryPasskeys: Record<string, LocalPasskey>;
};

const KEY = "wave.local.v1";
const EMPTY: LocalState = {
  wallet: null,
  identity: null,
  recoveryIdentities: {},
  passkeys: {},
  recoveryPasskeys: {},
};

/** A wallet from before the plan had only a World ID owner and no extra methods. */
function migrate(state: LocalState): LocalState {
  const old = state.wallet as (LocalWallet & { ownerNullifierHash?: Hex }) | null;
  if (!old || old.plan || !old.ownerNullifierHash) return state;
  const plan: WalletPlan = { owner: { kind: "world", nullifierHash: old.ownerNullifierHash }, extras: [] };
  return { ...state, wallet: { address: old.address, plan, rootHint: old.rootHint } };
}

let cached: LocalState | null = null;
const listeners = new Set<() => void>();

function read(): LocalState {
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(KEY);
    cached = raw ? migrate({ ...EMPTY, ...(JSON.parse(raw) as Partial<LocalState>) }) : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function write(next: LocalState) {
  cached = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows can block storage. The state still lives until reload.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
      cached = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Null during the server render and hydration. Then the stored state. */
export function useLocalState(): LocalState | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function setWallet(wallet: LocalWallet | null) {
  write({ ...read(), wallet });
}

/** Start over: this browser forgets the wallet, the test identity and the passkey IDs. */
export function resetLocal() {
  write(EMPTY);
}

export function setRootHint(rootHint: Hex) {
  const state = read();
  if (state.wallet) write({ ...state, wallet: { ...state.wallet, rootHint } });
}

export function randomField(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

export function randomIdentity(): DevIdentity {
  return { trapdoor: randomField(), nullifier: randomField() };
}

/** Read the test identity, or make one on first use. */
export function ensureIdentity(): DevIdentity {
  const state = read();
  if (state.identity) return state.identity;
  const identity = randomIdentity();
  write({ ...state, identity });
  return identity;
}

/** After a recovery, the owner is the identity that the owner made for it. */
export function saveRecoveryIdentity(nullifierHash: Hex, identity: DevIdentity) {
  const state = read();
  write({
    ...state,
    recoveryIdentities: { ...state.recoveryIdentities, [BigInt(nullifierHash).toString()]: identity },
  });
}

/** The test identity of this owner, if a recovery in this browser made it. */
export function recoveryIdentityOf(owner: Hex | null): DevIdentity | undefined {
  return owner ? read().recoveryIdentities[BigInt(owner).toString()] : undefined;
}

function passkeyKey(address: Address, slot: PasskeySlot): string {
  return `${address.toLowerCase()}:${slot}`;
}

export function savePasskey(address: Address, slot: PasskeySlot, passkey: LocalPasskey) {
  const state = read();
  write({
    ...state,
    passkeys: { ...state.passkeys, [passkeyKey(address, slot)]: passkey },
  });
}

export function findPasskey(
  state: LocalState,
  address: Address,
  slot: PasskeySlot,
): LocalPasskey | null {
  return state.passkeys[passkeyKey(address, slot)] ?? null;
}

export function getPasskey(address: Address, slot: PasskeySlot): LocalPasskey | null {
  return findPasskey(read(), address, slot);
}

/** A recovery names this key. It signs only after the recovery runs. */
export function saveRecoveryPasskey(x: Hex, passkey: LocalPasskey) {
  const state = read();
  write({ ...state, recoveryPasskeys: { ...state.recoveryPasskeys, [x.toLowerCase()]: passkey } });
}

/** After a recovery, the owner slot holds the new key that this browser made for it. */
export function adoptRecoveryPasskey(address: Address, slot: PasskeySlot, x: Hex) {
  const state = read();
  const passkey = state.recoveryPasskeys[x.toLowerCase()];
  if (!passkey || state.passkeys[passkeyKey(address, slot)]?.credentialId === passkey.credentialId) return;
  savePasskey(address, slot, passkey);
}
