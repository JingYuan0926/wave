import { useState } from "react";
import { KeyRound, ServerOff, TriangleAlert } from "lucide-react";
import { NETWORK_NAME } from "../lib/wc/config";
import { passkeysSupported } from "../lib/wc/passkey";
import { useStore } from "../store";
import { PrimaryButton, WaveMark } from "../components/ui";

/** First run: the passkey that owns the wallet. The address follows from it. */
export function CreateWallet() {
  const { createWallet } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      await createWallet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/NotAllowedError|aborted|cancel/i.test(msg) ? "The passkey prompt was closed. Try again when you're ready." : msg);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col px-6 pb-10 pt-16">
      <WaveMark className="size-12 text-wave-deep" />
      <h1 className="mt-6 text-[2rem] font-bold leading-tight tracking-tight">A wallet with no seed phrase</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        Your passkey owns this wallet: Face ID, Touch ID, Windows Hello or a security key. There is no seed phrase and
        no private key to write down or leak.
      </p>
      <ul className="mt-6 space-y-3 text-[15px] text-ink-2">
        <li>
          <span className="font-semibold text-ink">Spending rules onchain.</span> Small payments run at once; large ones
          wait 24 hours and you can cancel them.
        </li>
        <li>
          <span className="font-semibold text-ink">No gas to hold.</span> WAVE pays the WBT gas on {NETWORK_NAME}.
        </li>
      </ul>

      <div className="mt-auto">
        {error && (
          <div className="mb-3 flex gap-3 rounded-[20px] bg-danger-soft p-4" role="alert">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <p className="text-sm leading-snug text-ink">{error}</p>
          </div>
        )}
        {!passkeysSupported() && (
          <p className="mb-3 text-sm font-semibold text-danger">This browser has no passkey support.</p>
        )}
        <PrimaryButton onClick={create} disabled={busy || !passkeysSupported()}>
          <KeyRound className="size-5" aria-hidden />
          {busy ? "Waiting for your passkey…" : "Create wallet with a passkey"}
        </PrimaryButton>
        <p className="mt-3 text-center text-xs text-muted">{NETWORK_NAME} test network · tokens have no value</p>
      </div>
    </div>
  );
}

/** The build has no contracts/deployments/whitechain-sepolia.json. */
export function NotDeployed() {
  return (
    <div className="flex h-full flex-col justify-center px-6 text-center">
      <ServerOff className="mx-auto size-10 text-muted" aria-hidden />
      <h1 className="mt-4 text-2xl font-bold tracking-tight">WAVE is not deployed yet</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
        This build has no {NETWORK_NAME} contracts. Run <code className="font-mono text-sm">npm run deploy:wc</code> in{" "}
        <code className="font-mono text-sm">contracts/</code>, then rebuild the extension.
      </p>
    </div>
  );
}
