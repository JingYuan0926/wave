// The wallet's passkey: WebAuthn P-256. Ported from the web app's lib/ui/passkey.ts.
// The browser keeps the private key. This file stores only the credential id and the public key.
import { Authentication, Registration } from "ox/webauthn";
import { encodePacked, pad, size, stringToHex, type Hex } from "viem";

export type StoredPasskey = {
  credentialId: string;
  x: Hex;
  y: Hex;
  /** WebAuthn BE flag at enrolment: true for a synced passkey (iCloud, Google Password Manager). */
  backupEligible: boolean;
  createdAt: number;
};

const STORAGE_KEY = "wave.wc.passkey";

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

export function loadPasskey(): StoredPasskey | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredPasskey) : null;
  } catch {
    return null;
  }
}

function savePasskey(p: StoredPasskey) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

export function forgetPasskey() {
  localStorage.removeItem(STORAGE_KEY);
}

/** In the extension side panel the host is the extension id, which Chrome accepts as the RP id. */
const rpId = () => window.location.hostname;

/** Creates the passkey that owns the wallet. Face ID, Touch ID, Windows Hello or a security key. */
export async function createPasskey(name: string): Promise<StoredPasskey> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userVerification = "required" as const;
  const credential = await Registration.create({
    name,
    challenge,
    rp: { id: rpId(), name: "WAVE" },
    authenticatorSelection: { residentKey: "preferred", userVerification },
  });
  const { deviceType } = Registration.verify({
    credential,
    challenge,
    origin: window.location.origin,
    rpId: rpId(),
    userVerification,
  });
  const stored: StoredPasskey = {
    credentialId: credential.id,
    x: pad(credential.publicKey.x, { size: 32 }),
    y: pad(credential.publicKey.y!, { size: 32 }),
    backupEligible: deviceType === "multiDevice",
    createdAt: Date.now(),
  };
  savePasskey(stored);
  return stored;
}

/**
 * Signs a 32-byte hash (the userOpHash) and returns Solady's compact WebAuthn encoding:
 * uint16 authDataLen || authenticatorData || clientDataJSON || uint16 challengeIndex
 * || uint16 typeIndex || r || s. ox already applies low-s.
 */
export async function signHash(hash: Hex, passkey: StoredPasskey): Promise<Hex> {
  const { metadata, signature } = await Authentication.sign({
    challenge: hash,
    credentialId: passkey.credentialId,
    rpId: rpId(),
    userVerification: "required",
  });
  const authData = metadata.authenticatorData;
  return encodePacked(
    ["uint16", "bytes", "bytes", "uint16", "uint16", "bytes32", "bytes32"],
    [
      size(authData),
      authData,
      stringToHex(metadata.clientDataJSON),
      metadata.challengeIndex!,
      metadata.typeIndex!,
      pad(signature.r, { size: 32 }),
      pad(signature.s, { size: 32 }),
    ],
  );
}
