import { useEffect, useRef, useState } from "react";
import { IDKitRequestWidget, orbLegacy, type IDKitResult } from "@worldcoin/idkit";
import { FlaskConical, ScanLine } from "lucide-react";
import {
  WORLD_ACTION,
  api,
  ensureIdentity,
  errorText,
  proofFromIdkit,
  type DevIdentity,
  type WorldConfig,
  type WorldProof,
  type WorldRpContextResponse,
} from "../lib/wave";
import { PrimaryButton } from "./ui";

export const TEST_IDENTITY_LABEL = "Test identity. Not a real World ID.";

type ScanProps = {
  world: WorldConfig;
  /** The sig_hash, or CREATE_SIGNAL for the creation scan. */
  signal: string;
  label: string;
  /** Another test identity, for example after a recovery. */
  identity?: DevIdentity;
  disabled?: boolean;
  /** Starts the scan when this step opens. The owner already pressed Approve. */
  autoStart?: boolean;
  /** `raw` is the IDKit result, for the backend verify call. */
  onProof: (proof: WorldProof, raw: unknown) => void | Promise<void>;
};

/** Runs `start` once. React runs an effect twice in development, and a scan must not start twice. */
function useAutoStart(on: boolean | undefined, start: () => void) {
  const started = useRef(false);
  useEffect(() => {
    if (!on || started.current) return;
    started.current = true;
    start();
    // Only the first render decides this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function ScanError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="mt-2 text-center text-sm font-semibold text-danger">
      {text}
    </p>
  );
}

function DevScan({ signal, label, identity, disabled, autoStart, onProof }: Omit<ScanProps, "world">) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prove = async () => {
    setBusy(true);
    setError(null);
    try {
      const proof = await api.worldDevProof(identity ?? ensureIdentity(), signal);
      await onProof(proof, proof);
    } catch (cause) {
      setError(errorText(cause, "The test proof failed."));
    } finally {
      setBusy(false);
    }
  };

  useAutoStart(autoStart, () => void prove());

  return (
    <div className="w-full">
      <PrimaryButton onClick={prove} disabled={disabled || busy}>
        <FlaskConical className="size-5" aria-hidden />
        {busy ? "Making the proof…" : label}
      </PrimaryButton>
      <p className="mt-2 text-center text-sm text-muted">{TEST_IDENTITY_LABEL}</p>
      <ScanError text={error} />
    </div>
  );
}

function IdkitScan({
  world,
  signal,
  label,
  disabled,
  autoStart,
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
      setError(errorText(cause, "WAVE could not start the scan."));
    } finally {
      setBusy(false);
    }
  };

  useAutoStart(autoStart, () => void start());

  const onSuccess = async (result: IDKitResult) => {
    try {
      await onProof(proofFromIdkit(result), result);
    } catch (cause) {
      setError(errorText(cause, "The proof was not usable."));
    }
  };

  return (
    <div className="w-full">
      <PrimaryButton onClick={start} disabled={disabled || busy}>
        <ScanLine className="size-5" aria-hidden />
        {busy ? "Starting…" : label}
      </PrimaryButton>
      {rpContext && (
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
      )}
      <ScanError text={error} />
    </div>
  );
}

/** The real World ID step: the IDKit widget and its QR code, or the local test identity. */
export function WorldScan({ world, ...props }: ScanProps) {
  if (world.mode === "dev") return <DevScan {...props} />;
  return <IdkitScan world={world} {...props} />;
}
