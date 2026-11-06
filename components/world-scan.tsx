"use client";

import { IDKitRequestWidget, orbLegacy, type IDKitResult } from "@worldcoin/idkit";
import { FlaskConical, ScanLine } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api-client";
import {
  WORLD_ACTION,
  type DevIdentity,
  type WorldConfig,
  type WorldProof,
  type WorldRpContextResponse,
} from "@/lib/api-types";
import { ensureIdentity } from "@/lib/ui/local";
import { proofFromIdkit } from "@/lib/ui/world";
import { Button, Notice } from "./ui";

export const TEST_IDENTITY_LABEL = "Test identity. Not a real World ID.";

type ScanProps = {
  world: WorldConfig;
  /** The sig_hash, or CREATE_SIGNAL for the creation scan. */
  signal: string;
  label: string;
  /** The security demo passes another identity here. */
  identity?: DevIdentity;
  disabled?: boolean;
  /** `raw` is the IDKit result, for the backend verify call. */
  onProof: (proof: WorldProof, raw: unknown) => void | Promise<void>;
};

function DevScan({ signal, label, identity, disabled, onProof }: Omit<ScanProps, "world">) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prove = async () => {
    setBusy(true);
    setError(null);
    try {
      const proof = await api.worldDevProof(identity ?? ensureIdentity(), signal);
      await onProof(proof, proof);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The test proof failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={prove} disabled={disabled || busy}>
        <FlaskConical aria-hidden="true" className="size-4" />
        {busy ? "Making the proof…" : label}
      </Button>
      <p className="text-center text-sm text-muted-foreground">{TEST_IDENTITY_LABEL}</p>
      {error ? <Notice tone="danger" title="The scan failed">{error}</Notice> : null}
    </div>
  );
}

function IdkitScan({
  world,
  signal,
  label,
  disabled,
  onProof,
}: Omit<ScanProps, "world" | "identity"> & { world: Extract<WorldConfig, { mode: "idkit" }> }) {
  const [rpContext, setRpContext] = useState<WorldRpContextResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setRpContext(await api.worldRpContext());
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not start the scan.");
    } finally {
      setBusy(false);
    }
  };

  const onSuccess = async (result: IDKitResult) => {
    try {
      await onProof(proofFromIdkit(result), result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The proof was not usable.");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={start} disabled={disabled || busy}>
        <ScanLine aria-hidden="true" className="size-4" />
        {busy ? "Starting…" : label}
      </Button>
      {rpContext ? (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={world.appId}
          action={WORLD_ACTION}
          rp_context={rpContext}
          allow_legacy_proofs
          environment={world.environment}
          preset={orbLegacy({ signal })}
          onSuccess={onSuccess}
          onError={(code) => setError(`World App returned an error: ${code}.`)}
        />
      ) : null}
      {error ? <Notice tone="danger" title="The scan failed">{error}</Notice> : null}
    </div>
  );
}

export function WorldScan({ world, ...props }: ScanProps) {
  if (world.mode === "dev") return <DevScan {...props} />;
  return <IdkitScan world={world} {...props} />;
}
