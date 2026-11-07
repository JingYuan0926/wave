import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Fingerprint } from "lucide-react";
import { shortAddr } from "../lib/format";
import { parseTokenAmount, passkeyErrorText, passkeysSupported, plainAmount, recipientProblem, shortHex, type Address } from "../lib/wave";
import { NETWORK_NAME, USDT, type WcDeployment } from "../lib/wc/config";
import { createPasskey, loadPasskey, type StoredPasskey } from "../lib/wc/passkey";
import { useWhitechainPayments } from "../lib/wc/switch";
import {
  RelayerError,
  isDeployed,
  readUsdtBalance,
  readUsdtTiers,
  selectTier,
  sendUsdt,
  walletAddress,
  type ChainTier,
  type SendResult,
  type SendStep,
} from "../lib/wc/wallet";
import { useStore } from "../store";
import { PrimaryButton, Sheet, TokenIcon, focusRing } from "../components/ui";
import { ReviewRows, Stop } from "./SendSheet";

type SheetProps = { onClose: () => void; recipientId?: string };

/** The send of the Whitechain switch: USDT through an ERC-4337 account, with sponsored gas. */
export function WhitechainSendSheet({ onClose, recipientId }: SheetProps) {
  const { deployment } = useWhitechainPayments();
  const [passkey, setPasskey] = useState<StoredPasskey | null>(loadPasskey);

  if (!deployment) {
    return (
      <Sheet title="Send money" onClose={onClose}>
        <p className="py-6 text-center text-[15px] text-muted" role="status">
          Checking Whitechain…
        </p>
      </Sheet>
    );
  }
  if (!passkey) return <CreatePasskey onClose={onClose} onCreated={setPasskey} />;
  return <SendForm deployment={deployment} passkey={passkey} onClose={onClose} recipientId={recipientId} />;
}

/** The wallet address comes from the passkey, so the passkey comes first. */
function CreatePasskey({ onClose, onCreated }: { onClose: () => void; onCreated: (passkey: StoredPasskey) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!passkeysSupported()) {
      setError("This browser has no passkeys.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await createPasskey("WAVE Whitechain"));
    } catch (cause) {
      setError(passkeyErrorText(cause, "The passkey could not be created."));
      setBusy(false);
    }
  };

  return (
    <Sheet title="Send money" onClose={onClose}>
      <p className="text-[15px] leading-snug text-ink-2">
        Your Whitechain wallet needs its own passkey. The passkey sets the wallet address. Then you can add USDT to that address.
      </p>
      {error && <Stop>{error}</Stop>}
      <div className="mt-5">
        <PrimaryButton disabled={busy} onClick={() => void create()}>
          <Fingerprint className="size-5" aria-hidden /> {busy ? "Check your device" : "Create Whitechain passkey"}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

type Wallet = { address: Address; deployed: boolean; balance: bigint; tiers: ChainTier[] };

/** Reads the wallet now and every 15 seconds, so a deposit shows without a reload. */
function useWallet(d: WcDeployment, passkey: StoredPasskey, paused: boolean) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    let live = true;
    const read = async () => {
      try {
        const address = await walletAddress(d, passkey);
        const deployed = await isDeployed(d, address);
        const [balance, tiers] = await Promise.all([readUsdtBalance(d, address), readUsdtTiers(d, address, deployed)]);
        if (!live) return;
        setWallet({ address, deployed, balance, tiers });
        setError(null);
      } catch {
        if (live) setError("Whitechain does not answer, so the balance is not known.");
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [d, passkey, paused]);

  return { wallet, error };
}

function WalletCard({ wallet }: { wallet: Wallet | null }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mb-5 rounded-[24px] bg-wave-mist p-4">
      <p className="text-sm text-ink-2">Your Whitechain wallet · add USDT here</p>
      <p className="mt-1 break-all font-mono text-sm leading-relaxed">{wallet?.address ?? "--"}</p>
      {wallet && (
        <button
          type="button"
          onClick={() => void copy()}
          className={`mt-2 inline-flex h-9 items-center gap-2 rounded-full bg-white px-3 text-sm font-semibold ring-1 ring-line hover:bg-surface-2 ${focusRing}`}
        >
          {copied ? <Check className="size-4 text-positive" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
        </button>
      )}
    </div>
  );
}

type Stage =
  | { name: "form" }
  | { name: "review" }
  | { name: "working"; step: SendStep }
  | { name: "done"; result: SendResult }
  | { name: "failed"; message: string; unknown: boolean };

const STEP_TEXT: Record<SendStep, { title: string; body: string }> = {
  sponsor: { title: "Getting sponsored gas", body: "The server checks this transfer." },
  device: { title: "Check your device", body: "Your passkey approves this exact transfer." },
  chain: { title: "Sending", body: "The relayer sends this to Whitechain." },
};

function SendForm({ deployment: d, passkey, onClose, recipientId }: SheetProps & { deployment: WcDeployment; passkey: StoredPasskey }) {
  const { state } = useStore();
  const [stage, setStage] = useState<Stage>({ name: "form" });
  const [to, setTo] = useState(state.recipients.find((r) => r.id === recipientId)?.address ?? "");
  const [raw, setRaw] = useState("");
  const { wallet, error: readError } = useWallet(d, passkey, stage.name === "working");

  const address = to.trim();
  const recipient = state.recipients.find((r) => r.address.toLowerCase() === address.toLowerCase());
  const toProblem = address && wallet ? recipientProblem(address, wallet.address) : null;

  const parsed = raw ? parseTokenAmount(raw, USDT.decimals) : null;
  const units = parsed?.value ? parsed.value : null;
  const balanceText = wallet ? `${plainAmount(wallet.balance, USDT.decimals)} USDT` : "--";
  const overBalance = !!wallet && units !== null && units > wallet.balance;
  const amountError = parsed?.error ?? (overBalance ? `More than your balance of ${balanceText}` : null);

  // WavePolicy refuses a transfer that needs the delay queue. This sheet has no queue, so it stops first.
  const tier = wallet && units !== null ? selectTier(wallet.tiers, units) : null;
  const ruleStop =
    wallet && units !== null && !amountError && (!tier || tier.delay !== 0)
      ? "This amount is above the instant limit of this wallet. Send a smaller amount."
      : null;

  const canContinue = !!wallet && !!address && !toProblem && units !== null && !amountError && !ruleStop;

  const approve = async () => {
    if (units === null) return;
    const progress: { step: SendStep } = { step: "sponsor" };
    try {
      const result = await sendUsdt(d, passkey, address as Address, units, (step) => {
        progress.step = step;
        setStage({ name: "working", step });
      });
      setStage({ name: "done", result });
    } catch (cause) {
      const nothingSent = progress.step !== "chain" || (cause instanceof RelayerError && cause.nothingSent);
      const message = cause instanceof RelayerError ? cause.message : passkeyErrorText(cause, "This transfer failed.");
      setStage({ name: "failed", message, unknown: !nothingSent });
    }
  };

  const title = stage.name === "review" ? "Check and approve" : "Send money";

  return (
    <Sheet title={title} onClose={onClose}>
      {stage.name === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canContinue) setStage({ name: "review" });
          }}
        >
          <WalletCard wallet={wallet} />

          <label htmlFor="wc-send-to" className="text-[15px] font-medium text-ink-2">
            To
          </label>
          <input
            id="wc-send-to"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Wallet address, 0x…"
            value={to}
            data-autofocus
            aria-invalid={!!toProblem}
            aria-describedby={toProblem ? "wc-send-to-error" : undefined}
            onChange={(e) => setTo(e.target.value)}
            className={`mt-2 h-13 w-full rounded-2xl bg-surface px-4 font-mono text-[15px] outline-none ring-wave-deep placeholder:font-sans placeholder:text-muted focus-visible:ring-2 ${
              toProblem ? "ring-2 ring-danger" : ""
            }`}
          />
          {toProblem && (
            <p id="wc-send-to-error" className="mt-1.5 text-sm font-semibold text-danger">
              {toProblem}
            </p>
          )}

          <div className="mt-5 rounded-[24px] bg-surface p-4">
            <div className="flex items-center justify-between">
              <label htmlFor="wc-send-amount" className="text-[15px] font-medium text-ink-2">
                Amount
              </label>
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink pl-1 pr-3 text-sm font-semibold text-white">
                <TokenIcon token="USDT" size="sm" />
                USDT
              </span>
            </div>
            <input
              id="wc-send-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={raw}
              aria-invalid={!!amountError}
              aria-describedby="wc-amount-help"
              onChange={(e) => {
                const v = e.target.value.replace(",", ".");
                if (/^\d*\.?\d{0,6}$/.test(v)) setRaw(v);
              }}
              className="mt-2 w-full bg-transparent text-[2.5rem] font-bold tabular-nums tracking-tight outline-none placeholder:text-[#b3b3b3]"
            />
            <p id="wc-amount-help" className={`text-sm ${amountError ? "font-semibold text-danger" : "text-muted"}`}>
              {amountError ?? `Balance: ${balanceText}`}
            </p>
          </div>

          {readError && <Stop>{readError}</Stop>}
          {ruleStop && <Stop>{ruleStop}</Stop>}

          <div className="mt-5">
            <PrimaryButton type="submit" disabled={!canContinue}>
              Continue
            </PrimaryButton>
          </div>
        </form>
      )}

      {stage.name === "review" && (
        <div>
          <p className="text-sm text-muted">Total</p>
          <p className="text-3xl font-bold tabular-nums tracking-tight">{plainAmount(units, USDT.decimals)} USDT</p>

          <ReviewRows
            rows={[
              ["To", recipient ? `${recipient.name} · ${shortAddr(address)}` : shortAddr(address)],
              ["Network", NETWORK_NAME],
              ["Gas", "0 (Sponsored)"],
              ["Methods required", "Passkey"],
            ]}
          />
          {wallet && !wallet.deployed && <p className="mt-3 text-center text-sm text-muted">This transfer also deploys your wallet.</p>}

          {/* A poll can change the balance while this step is open. */}
          {!canContinue && <Stop>{ruleStop ?? amountError ?? readError ?? "This send can no longer run. Edit it first."}</Stop>}

          <div className="mt-5 space-y-2">
            {canContinue && (
              <PrimaryButton onClick={() => void approve()}>
                <Fingerprint className="size-5" aria-hidden /> Approve with Passkey
              </PrimaryButton>
            )}
            <PrimaryButton tone="ghost" onClick={() => setStage({ name: "form" })}>
              Edit
            </PrimaryButton>
          </div>
        </div>
      )}

      {stage.name === "working" && (
        <div className="flex flex-col items-center py-6 text-center" role="status" aria-live="polite">
          <div className="relative grid size-28 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-wave/40 motion-reduce:hidden" aria-hidden />
            <span className="absolute inset-2 rounded-full bg-wave-soft" aria-hidden />
            <Fingerprint className="relative size-12 text-wave-deep" strokeWidth={1.6} aria-hidden />
          </div>
          <p className="mt-6 text-xl font-bold">{STEP_TEXT[stage.step].title}</p>
          <p className="mt-2 max-w-[17rem] text-[15px] leading-relaxed text-muted">{STEP_TEXT[stage.step].body}</p>
        </div>
      )}

      {stage.name === "done" && (
        <SendOutcome result={stage.result} amount={plainAmount(units, USDT.decimals)} to={address} onClose={onClose} />
      )}

      {stage.name === "failed" && (
        <div>
          <Stop>
            {stage.unknown
              ? `${stage.message} This transfer may have reached Whitechain. Check your balance before you try again.`
              : `${stage.message} Nothing was sent.`}
          </Stop>
          <div className="mt-5 space-y-2">
            <PrimaryButton onClick={() => setStage({ name: "review" })}>Back to review</PrimaryButton>
            <PrimaryButton tone="ghost" onClick={onClose}>
              Close
            </PrimaryButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** Only a receipt with a successful UserOperationEvent shows as sent. */
function SendOutcome({ result, amount, to, onClose }: { result: SendResult; amount: string; to: string; onClose: () => void }) {
  const title = result.success ? "Sent" : result.pending ? "Not confirmed yet" : "The transfer failed";
  const body = result.success
    ? `${amount} USDT went to ${shortAddr(to)} on ${NETWORK_NAME}.`
    : result.pending
      ? "The transaction left the server, but no receipt came in time. Open the explorer to see the result."
      : "The transaction ran on Whitechain, but the account refused the transfer. No USDT moved.";
  return (
    <div className="flex flex-col items-center py-6 text-center">
      <p className="text-xl font-bold">{title}</p>
      <p className="mt-2 max-w-[18rem] text-[15px] leading-relaxed text-muted">{body}</p>
      <p className="mt-3 text-sm leading-snug text-ink-2">
        Transaction: <span className="font-mono">{shortHex(result.txHash, 10, 8)}</span>{" "}
        <a
          href={result.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 rounded font-semibold underline underline-offset-2 ${focusRing}`}
        >
          Open in explorer
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </p>
      <div className="mt-5 w-full">
        <PrimaryButton onClick={onClose}>Done</PrimaryButton>
      </div>
    </div>
  );
}
