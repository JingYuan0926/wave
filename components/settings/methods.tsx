"use client";

import { Fingerprint, Globe, Nfc } from "lucide-react";
import { useState } from "react";
import { ApproveFlow, requireMethod, type ApprovalRequest } from "@/components/approve-flow";
import { Badge, Button, Card, Notice, SectionTitle, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import type { MethodView } from "@/lib/api-types";
import { findPasskey, savePasskey } from "@/lib/ui/local";
import { enrolPasskey, passkeysSupported } from "@/lib/ui/passkey";
import { WORLD_ID, freePasskeySlot, methodLabel } from "@/lib/ui/rules";

function MethodRow({
  view,
  onRemove,
}: {
  view: MethodView;
  onRemove: (view: MethodView) => void;
}) {
  const { wallet, local, info } = useWallet();
  const isPasskey = view.ref.kind === "passkey";
  const Icon = isPasskey ? Fingerprint : Globe;
  const here =
    view.ref.kind === "passkey" &&
    wallet !== null &&
    local !== null &&
    findPasskey(local, wallet.address, view.ref.slot) !== null;

  return (
    <li className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{methodLabel(view.ref, info?.world)}</p>
        <p className="text-sm text-muted-foreground">
          {view.backup === "synced"
            ? "Synced passkey. It approves small tiers only."
            : view.backup === "device-bound"
              ? "Device-bound passkey."
              : info?.world.mode === "dev"
                ? "Not a real World ID. Always on."
                : "Always on. World App approves."}
          {isPasskey && !here ? " Not on this browser." : ""}
        </p>
      </div>
      {isPasskey ? (
        <Button variant="ghost" onClick={() => onRemove(view)}>
          Remove
        </Button>
      ) : (
        <Badge>Always</Badge>
      )}
    </li>
  );
}

export function Methods() {
  const { wallet, account, info, offline } = useWallet();
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!wallet || !account) return null;

  const slot = freePasskeySlot(account.methods, account.pending);

  const open = (next: ApprovalRequest) => {
    setSheetKey((key) => key + 1);
    setRequest(next);
  };

  const addPasskey = async () => {
    if (!slot) return;
    setEnrolling(true);
    setError(null);
    try {
      // The WebAuthn user ID comes from this name. Two passkeys with one user ID on one
      // device replace each other, so the name holds the slot.
      const passkey = await enrolPasskey(`WAVE ${wallet.address.slice(0, 8)} passkey ${slot}`);
      savePasskey(wallet.address, slot, { credentialId: passkey.credentialId });
      open({
        action: {
          kind: "install-passkey",
          slot,
          publicKey: passkey.publicKey,
          backupEligible: passkey.backupEligible,
        },
        choices: requireMethod(account.methods, WORLD_ID, info?.world),
        method: WORLD_ID,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The device did not create a passkey.");
    } finally {
      setEnrolling(false);
    }
  };

  const remove = (view: MethodView) => {
    if (view.ref.kind !== "passkey") return;
    open({
      action: { kind: "remove-passkey", slot: view.ref.slot },
      choices: requireMethod(account.methods, WORLD_ID, info?.world),
      method: WORLD_ID,
    });
  };

  return (
    <Card>
      <SectionTitle hint="Adding or removing a method needs World ID, and waits in the queue.">
        Methods
      </SectionTitle>
      <ul className="flex flex-col gap-3">
        {account.methods.map((view) => (
          <MethodRow key={view.validator} view={view} onRemove={remove} />
        ))}
        <li className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
            <Nfc aria-hidden="true" className="size-4 text-muted-foreground" />
          </span>
          <p className="flex-1 text-sm text-muted-foreground">NFC card: coming later</p>
          <Button variant="ghost" disabled>
            Add
          </Button>
        </li>
      </ul>

      <div className="mt-4 flex flex-col gap-2">
        <Button
          variant="secondary"
          onClick={addPasskey}
          disabled={!slot || enrolling || offline || !passkeysSupported()}
        >
          <Fingerprint aria-hidden="true" className="size-4" />
          {enrolling ? "Waiting for your device…" : "Add passkey (Face ID / Touch ID / security key)"}
        </Button>
        {!slot ? (
          <p className="text-sm text-muted-foreground">
            All three passkey slots are in use or queued.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Face ID and Touch ID often report a synced passkey. A synced passkey approves small
          tiers only. A security key can be device-bound. Choose it in the browser prompt.
        </p>
        {error ? <Notice tone="danger" title="WAVE could not add the passkey">{error}</Notice> : null}
      </div>

      {request ? (
        <Sheet title="Change methods" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </Card>
  );
}
