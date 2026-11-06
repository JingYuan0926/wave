"use client";

import { useState } from "react";
import { ApproveFlow, type ApprovalRequest } from "@/components/approve-flow";
import { Button, Card, Field, Notice, SectionTitle, SelectField, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import { WorldScan } from "@/components/world-scan";
import { CREATE_SIGNAL, type Hex } from "@/lib/api-types";
import { randomIdentity, saveRecoveryIdentity, saveRecoveryPasskey } from "@/lib/ui/local";
import { enrolPasskey, passkeysSupported, type EnrolledPasskey } from "@/lib/ui/passkey";
import { recoveryChoices } from "@/lib/ui/rules";

const WORD = /^0x[0-9a-fA-F]{64}$/;

/** The owner method is a passkey, so the recovery names a new passkey. */
function ProposeKeyRecovery() {
  const { account, info, offline } = useWallet();
  const [key, setKey] = useState<EnrolledPasskey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);

  if (!account || !info) return null;

  const enrol = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await enrolPasskey(`WAVE recovery ${crypto.randomUUID().slice(0, 8)}`);
      saveRecoveryPasskey(made.publicKey.x, { credentialId: made.credentialId });
      setKey(made);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The device did not create a passkey.");
    } finally {
      setBusy(false);
    }
  };

  const propose = () => {
    if (!key) return;
    setSheetKey((count) => count + 1);
    setRequest({
      action: {
        kind: "propose-recovery",
        change: { kind: "owner-key", publicKey: key.publicKey, backupEligible: key.backupEligible },
      },
      choices: recoveryChoices(account.methods, info.world),
      note: "Propose with one device-bound passkey. A second one must approve it.",
    });
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      <h3 className="text-sm font-medium">Start a recovery</h3>
      <Button variant="secondary" disabled={busy || offline || !passkeysSupported()} onClick={enrol}>
        {busy ? "Waiting for your device…" : key ? "Make another new passkey" : "Make a new owner passkey"}
      </Button>
      <Button variant="secondary" disabled={!key || offline} onClick={propose}>
        Propose recovery
      </Button>
      {error ? <Notice tone="danger" title="WAVE could not make the passkey">{error}</Notice> : null}
      {request ? (
        <Sheet title="Start a recovery" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </div>
  );
}

/** One device-bound passkey proposes here. A second one approves in Pending actions. */
function ProposeRecovery() {
  const { account, info, offline } = useWallet();
  const [kind, setKind] = useState<"owner" | "root-source">("owner");
  const [value, setValue] = useState("");
  // The new owner scans with a new identity. The old one is what this flow replaces.
  const [identity] = useState(randomIdentity);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);

  if (!account || !info) return null;

  const valid = WORD.test(value) && BigInt(value) !== BigInt(0);
  const propose = () => {
    const word = value as Hex;
    setSheetKey((key) => key + 1);
    setRequest({
      action: {
        kind: "propose-recovery",
        change: kind === "owner" ? { kind, nullifierHash: word } : { kind, sourceId: word },
      },
      choices: recoveryChoices(account.methods, info.world),
      note: "Propose with one device-bound passkey. A second one must approve it.",
    });
  };

  return (
    <div className="mt-3 flex flex-col gap-3">
      <h3 className="text-sm font-medium">Start a recovery</h3>
      <SelectField
        label="What to change"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value as "owner" | "root-source");
          setValue("");
        }}
      >
        <option value="owner">Owner (World ID lost)</option>
        <option value="root-source">Root source (publisher stopped)</option>
      </SelectField>
      <Field
        label={kind === "owner" ? "New owner nullifier hash" : "New root source ID"}
        value={value}
        placeholder="0x… (32 bytes)"
        autoComplete="off"
        spellCheck={false}
        error={value && !valid ? "Enter 32 bytes of hex that are not all zero." : null}
        onChange={(event) => setValue(event.target.value.trim())}
      />
      {kind === "owner" ? (
        <WorldScan
          world={info.world}
          signal={CREATE_SIGNAL}
          label="Scan the new World ID"
          identity={identity}
          onProof={(proof) => {
            setValue(proof.nullifierHash);
            if (info.world.mode === "dev") saveRecoveryIdentity(proof.nullifierHash, identity);
          }}
        />
      ) : null}
      <Button variant="secondary" disabled={!valid || offline} onClick={propose}>
        Propose recovery
      </Button>
      {request ? (
        <Sheet title="Start a recovery" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </div>
  );
}

export function Fallback() {
  const { account } = useWallet();
  if (!account) return null;

  const { available, otherMethods } = account.recovery;
  // A synced passkey cannot propose or approve a recovery. The owner method cannot either.
  const deviceBound = account.methods.filter((view) => !view.owner && view.backup === "device-bound").length;
  const missing = Math.max(0, 2 - deviceBound);
  const lost = account.owner.kind === "world" ? "World ID" : "the owner passkey";
  // A wallet with no wait has no cancellation window, so a recovery runs at the second approval.
  const timing =
    account.waitSeconds === 0
      ? "With no wait, this runs at once, and nobody can cancel it."
      : "Only the owner method can cancel that during the wait.";

  return (
    <Card>
      <SectionTitle hint={`If you lose ${lost}, two other methods can move the wallet to a new owner. ${timing}`}>
        Fallback
      </SectionTitle>
      {available ? (
        <>
          <Notice tone="success" title="Recovery is available">
            You have {otherMethods} other methods. Keep them on different devices. Two methods on
            one phone are not independent.
          </Notice>
          {account.owner.kind === "world" ? <ProposeRecovery /> : <ProposeKeyRecovery />}
        </>
      ) : (
        <Notice tone="warning" title="You have no fallback">
          If you lose {lost} for good, you lose the funds. Enroll {missing} more
          device-bound {missing === 1 ? "method" : "methods"}, on different devices. A synced
          passkey cannot run a recovery.
        </Notice>
      )}
    </Card>
  );
}
