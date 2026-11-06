"use client";

import { Authentication, Registration } from "ox/webauthn";
import { encodePacked, pad, size, stringToHex, type Hex } from "viem";

/** The fixed witness length. sig_hash commits to it. */
const WITNESS_LENGTH = 512;

const MOCK = process.env.NEXT_PUBLIC_WAVE_MOCK === "1";

export type EnrolledPasskey = {
  credentialId: string;
  publicKey: { x: Hex; y: Hex };
  /** True when the passkey reports BE=1. The app labels it "Synced passkey". */
  backupEligible: boolean;
};

export function passkeysSupported(): boolean {
  return MOCK || typeof window.PublicKeyCredential !== "undefined";
}

/**
 * Face ID, Touch ID and security keys all go through this call. With no attachment the browser
 * offers each one. A security key is the usual way to get a device-bound method.
 */
export async function enrolPasskey(
  name: string,
  attachment?: "platform" | "cross-platform",
): Promise<EnrolledPasskey> {
  if (MOCK) {
    return {
      credentialId: `mock-${Date.now()}`,
      publicKey: { x: pad(`0x${Date.now().toString(16)}`), y: pad("0x02") },
      backupEligible: true,
    };
  }

  const rpId = window.location.hostname;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userVerification = "required" as const;
  const credential = await Registration.create({
    name,
    challenge,
    rp: { id: rpId, name: "WAVE" },
    authenticatorSelection: {
      ...(attachment ? { authenticatorAttachment: attachment } : {}),
      residentKey: "preferred",
      userVerification,
    },
  });
  const { deviceType } = Registration.verify({
    credential,
    challenge,
    origin: window.location.origin,
    rpId,
    userVerification,
  });
  const { x, y } = credential.publicKey;
  return {
    credentialId: credential.id,
    publicKey: { x: pad(x as Hex, { size: 32 }), y: pad(y as Hex, { size: 32 }) },
    backupEligible: deviceType === "multiDevice",
  };
}

/**
 * Sign sig_hash and return the padded witness for the ARBITRARY entry. With no credential ID, the
 * device shows its passkey picker for this site.
 */
export async function signWithPasskey(sigHash: Hex, credentialId?: string): Promise<Hex> {
  if (MOCK) return pad("0x01", { dir: "right", size: WITNESS_LENGTH });

  const { metadata, signature } = await Authentication.sign({
    challenge: sigHash,
    credentialId,
    rpId: window.location.hostname,
    userVerification: "required",
  });
  const authData = metadata.authenticatorData;
  // ox already applies low-s.
  const compact = encodePacked(
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
  return pad(encodePacked(["uint16", "bytes"], [size(compact), compact]), {
    dir: "right",
    size: WITNESS_LENGTH,
  });
}
