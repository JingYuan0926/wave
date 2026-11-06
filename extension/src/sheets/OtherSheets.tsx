import { useState, type FormEvent, type InputHTMLAttributes } from "react";
import {
  Bot,
  Check,
  Copy,
  Droplets,
  ExternalLink,
  Gauge,
  Plus,
  ScanFace,
  ScanLine,
  Send,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Address } from "viem";
import { METHOD_LABEL, type MethodId } from "../data";
import { NETWORK_NAME } from "../lib/wc/config";
import { cancelPending, claimTestTokens, type SendResult } from "../lib/wc/wallet";
import { useStore } from "../store";
import type { Nav } from "../nav";
import { METHOD_ICON, PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ApprovingView, DoneView } from "../components/Approving";

/* ---------- Receive (Add money) ---------- */

export function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const { state, refresh } = useStore();
  const address = state.wallet.address;
  const [copied, setCopied] = useState(false);
  const [faucet, setFaucet] = useState<{ state: "idle" | "busy" | "done" | "error"; text?: string; href?: string }>({
    state: "idle",
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const claim = async () => {
    setFaucet({ state: "busy" });
    try {
      const r = await claimTestTokens(address as Address);
      setFaucet({ state: "done", text: `${r.amount} tUSDT minted to your wallet.`, href: r.explorerUrl });
      refresh();
    } catch (e) {
      setFaucet({ state: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Sheet title="Add money" onClose={onClose}>
      <p className="text-[15px] leading-relaxed text-ink-2">
        Send USDT, USDC.e or tUSDT on <span className="font-semibold text-ink">{NETWORK_NAME}</span> to this address. Your
        wallet needs no WBT: WAVE pays the gas.
      </p>
      <div className="mt-4 rounded-[24px] bg-surface p-5">
        <p className="text-sm text-muted">{state.wallet.name}</p>
        <p className="mt-1 break-all font-mono text-lg leading-relaxed">{address || "…"}</p>
      </div>
      <div className="mt-5 space-y-2">
        <PrimaryButton onClick={copy} disabled={!address}>
          {copied ? <Check className="size-5" aria-hidden /> : <Copy className="size-5" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
        </PrimaryButton>
        <PrimaryButton tone="ghost" onClick={claim} disabled={!address || faucet.state === "busy"}>
          <Droplets className="size-5" aria-hidden />
          {faucet.state === "busy" ? "Minting…" : "Get 500 test tUSDT"}
        </PrimaryButton>
      </div>
      {faucet.text && (
        <p role="status" className={`mt-3 text-sm leading-snug ${faucet.state === "error" ? "font-semibold text-danger" : "text-ink-2"}`}>
          {faucet.text}{" "}
          {faucet.href && (
            <a href={faucet.href} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
              View transaction
            </a>
          )}
        </p>
      )}
      <p className="mt-3 text-xs leading-snug text-muted">tUSDT is WAVE's test token with an open mint. It has no value.</p>
    </Sheet>
  );
}

/* ---------- Scan ---------- */

export function ScanSheet({ onClose, onPayRecipient }: { onClose: () => void; onPayRecipient: () => void }) {
  return (
    <Sheet title="Pay with QR code" onClose={onClose}>
      <div className="relative mx-auto aspect-[4/3] w-full max-w-xs">
        <div className="absolute inset-3 grid place-items-center rounded-lg bg-surface">
          <ScanLine className="size-10 text-ink" strokeWidth={1.6} aria-hidden />
        </div>
        {/* Viewfinder corners */}
        {["left-0 top-0 border-l-4 border-t-4 rounded-tl-2xl", "right-0 top-0 border-r-4 border-t-4 rounded-tr-2xl", "left-0 bottom-0 border-l-4 border-b-4 rounded-bl-2xl", "right-0 bottom-0 border-r-4 border-b-4 rounded-br-2xl"].map((c) => (
          <span key={c} className={`absolute size-12 border-wave-deep ${c}`} aria-hidden />
        ))}
      </div>
      <p className="mt-5 text-center text-[15px] leading-relaxed text-ink-2">
        Camera scanning comes in the next build. For now, pay a saved recipient or paste an address.
      </p>
      <div className="mt-5">
        <PrimaryButton tone="ghost" onClick={onPayRecipient}>
          Send to an address instead
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

/* ---------- Do more ---------- */

export function MoreSheet({ onClose, nav }: { onClose: () => void; nav: Nav }) {
  const items: [string, LucideIcon, () => void][] = [
    ["Send", Send, () => nav.openSheet({ type: "send" })],
    ["Add money", Plus, () => nav.openSheet({ type: "receive" })],
    ["Scan", ScanLine, () => nav.openSheet({ type: "scan" })],
    ["Recipients", Users, () => nav.goTab("recipients")],
    ["Agents", Bot, () => nav.goTab("agents")],
    ["Limits", Gauge, () => nav.openSub("limits")],
    ["Methods", ScanFace, () => nav.openSub("methods")],
  ];
  return (
    <Sheet title="Do more" onClose={onClose}>
      <ul className="grid grid-cols-4 gap-y-4">
        {items.map(([label, Icon, fn]) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => {
                onClose();
                fn();
              }}
              className={`flex w-full flex-col items-center gap-2 rounded-2xl py-1.5 hover:bg-surface ${focusRing}`}
            >
              <span className="grid size-14 place-items-center rounded-full bg-wave-soft text-wave-deep" aria-hidden>
                <Icon className="size-6" strokeWidth={1.9} />
              </span>
              <span className="text-[13px] font-semibold">{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/* ---------- Form helpers ---------- */

function Field({
  id,
  label,
  error,
  ...input
}: { id: string; label: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="text-[15px] font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`mt-2 h-13 w-full rounded-2xl bg-surface px-4 text-base outline-none ring-wave-deep placeholder:text-muted focus-visible:ring-2 ${
          error ? "ring-2 ring-danger" : ""
        }`}
        {...input}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------- Add recipient ---------- */

export function AddRecipientSheet({ onClose }: { onClose: () => void }) {
  const { addRecipient } = useStore();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [errors, setErrors] = useState<{ name?: string; address?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const addr = address.trim();
    // Whitechain has no ENS, so a recipient is a 0x address.
    if (!name.trim()) next.name = "Enter a name";
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) next.address = "Enter a 0x address (42 characters)";
    setErrors(next);
    if (Object.keys(next).length) return;
    addRecipient({ name: name.trim(), address: addr });
    onClose();
  };

  return (
    <Sheet title="Add recipient" onClose={onClose}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field id="rec-name" label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="Ananya Rao" />
        <Field
          id="rec-address"
          label="Whitechain address"
          autoComplete="off"
          spellCheck={false}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          error={errors.address}
          placeholder="0x…"
          className="font-mono"
        />
        <div className="pt-2">
          <PrimaryButton type="submit">Save recipient</PrimaryButton>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------- Add agent ---------- */

export function AddAgentSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Agent budgets" onClose={onClose}>
      <NotOnWhitechain>
        Agent wallets run on the WAVE frame-transaction network. They are not on Whitechain yet.
      </NotOnWhitechain>
      <div className="mt-5">
        <PrimaryButton onClick={onClose}>OK</PrimaryButton>
      </div>
    </Sheet>
  );
}

export function NotOnWhitechain({ children }: { children: string }) {
  return (
    <div className="flex gap-3 rounded-[20px] bg-wave-mist p-4">
      <Bot className="mt-0.5 size-5 shrink-0 text-wave-deep" aria-hidden />
      <p className="text-sm leading-snug text-ink-2">{children}</p>
    </div>
  );
}

/* ---------- Approval-gated actions (cancel) ---------- */

function ApprovalSheet({
  title,
  description,
  methods,
  doneTitle,
  doneBody,
  run,
  onClose,
}: {
  title: string;
  description: string;
  methods: MethodId[];
  doneTitle: string;
  doneBody: string;
  run: (m: MethodId) => Promise<SendResult>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"choose" | "approving" | "done" | "error">("choose");
  const [method, setMethod] = useState<MethodId>(methods[0]);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState("");

  const go = async (m: MethodId) => {
    setMethod(m);
    setStep("approving");
    try {
      const r = await run(m);
      if (!r.success) throw new Error("The transaction ran, but the wallet refused the action.");
      setResult(r);
      setStep("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/NotAllowedError|aborted|cancel/i.test(msg) ? "The passkey prompt was closed. Nothing changed." : msg);
      setStep("error");
    }
  };

  return (
    <Sheet title={step === "done" ? "" : title} onClose={onClose}>
      {step === "choose" && (
        <>
          <p className="text-[15px] leading-relaxed text-ink-2">{description}</p>
          <div className="mt-5 space-y-2">
            {methods.map((m, i) => {
              const Icon = METHOD_ICON[m];
              return (
                <PrimaryButton key={m} tone={i === 0 ? "deep" : "ghost"} onClick={() => go(m)}>
                  <Icon className="size-5" aria-hidden /> Approve with {METHOD_LABEL[m]}
                </PrimaryButton>
              );
            })}
          </div>
        </>
      )}
      {step === "approving" && <ApprovingView method={method} />}
      {step === "done" && (
        <>
          <DoneView title={doneTitle} body={doneBody} onDone={onClose} />
          {result && (
            <a
              href={result.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-3 flex h-11 items-center justify-center gap-2 rounded-full text-[15px] font-semibold text-ink-2 hover:bg-surface ${focusRing}`}
            >
              View on Whitechain explorer <ExternalLink className="size-4" aria-hidden />
            </a>
          )}
        </>
      )}
      {step === "error" && (
        <div>
          <div className="flex gap-3 rounded-[20px] bg-danger-soft p-4" role="alert">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <p className="text-sm leading-snug text-ink">{error}</p>
          </div>
          <div className="mt-5 space-y-2">
            <PrimaryButton onClick={() => go(method)}>Try again</PrimaryButton>
            <PrimaryButton tone="ghost" onClick={onClose}>
              Close
            </PrimaryButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function CancelSheet({ pendingId, onClose }: { pendingId: string; onClose: () => void }) {
  const { state, removePending, refresh } = useStore();
  const [p] = useState(() => state.pending.find((x) => x.id === pendingId));
  if (!p || !state.passkey) return null;
  const passkey = state.passkey;
  return (
    <ApprovalSheet
      title="Cancel this action?"
      description={`“${p.title}” will not run. Your passkey signs the cancel; WAVE pays the gas.`}
      methods={["faceid"]}
      doneTitle="Cancelled"
      doneBody={`“${p.title}” won't run.`}
      run={async () => {
        const r = await cancelPending(passkey, p.id);
        if (r.success) {
          removePending(p.id);
          refresh();
        }
        return r;
      }}
      onClose={onClose}
    />
  );
}
