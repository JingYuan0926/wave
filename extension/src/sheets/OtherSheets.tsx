import { useState, type FormEvent, type InputHTMLAttributes } from "react";
import {
  Bot,
  Check,
  Copy,
  CreditCard,
  Gauge,
  Plus,
  ScanFace,
  ScanLine,
  Send,
  Users,
  type LucideIcon,
} from "lucide-react";
import { METHOD_LABEL, type MethodId } from "../data";
import { requestApproval } from "../lib/approvals";
import { useStore } from "../store";
import type { Nav } from "../nav";
import { METHOD_ICON, PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ApprovingView, DoneView } from "../components/Approving";

/* ---------- Receive (Add money / Request) ---------- */

export function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const address = state.wallet.address;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Sheet title="Receive money" onClose={onClose}>
      <p className="text-[15px] leading-relaxed text-ink-2">Send USDC or ETH on the WAVE devnet to this address.</p>
      <div className="mt-4 rounded-[24px] bg-surface p-5">
        <p className="text-sm text-muted">{state.wallet.name}</p>
        <p className="mt-1 break-all font-mono text-lg leading-relaxed">{address}</p>
      </div>
      <div className="mt-5">
        <PrimaryButton onClick={copy}>
          {copied ? <Check className="size-5" aria-hidden /> : <Copy className="size-5" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
        </PrimaryButton>
      </div>
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
        Scan a WAVE or Ethereum payment QR code. Camera scanning comes in the next build.
      </p>
      <div className="mt-5">
        <PrimaryButton tone="ghost" onClick={onPayRecipient}>
          Pay a recipient instead
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

/* ---------- Do more ---------- */

export function MoreSheet({ onClose, nav }: { onClose: () => void; nav: Nav }) {
  const items: [string, LucideIcon, () => void][] = [
    ["Send", Send, () => nav.openSheet({ type: "send" })],
    ["Add method", CreditCard, () => nav.openSheet({ type: "createCard" })],
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
    const isEns = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(addr);
    const isHex = /^0x[a-fA-F0-9]{40}$/.test(addr);
    if (!name.trim()) next.name = "Enter a name";
    if (!isEns && !isHex) next.address = "Enter a 0x address (42 characters) or an ENS name";
    setErrors(next);
    if (Object.keys(next).length) return;
    addRecipient({
      name: name.trim(),
      handle: isEns ? addr.toLowerCase() : undefined,
      address: isHex ? addr : "0x0000000000000000000000000000000000000000",
    });
    onClose();
  };

  return (
    <Sheet title="Add recipient" onClose={onClose}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field id="rec-name" label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="Ananya Rao" />
        <Field
          id="rec-address"
          label="Address or ENS"
          autoComplete="off"
          spellCheck={false}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          error={errors.address}
          placeholder="0x… or name.eth"
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
  const { addAgent } = useStore();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [limit, setLimit] = useState("");
  const [per, setPer] = useState<"day" | "week" | "month">("week");
  const [errors, setErrors] = useState<{ name?: string; limit?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const n = Number.parseFloat(limit);
    if (!name.trim()) next.name = "Give the agent a name";
    if (!(n > 0)) next.limit = "Enter a budget above 0";
    setErrors(next);
    if (Object.keys(next).length) return;
    addAgent({ name: name.trim(), purpose: purpose.trim() || "No description", limit: n, per, used: 0, active: true });
    onClose();
  };

  return (
    <Sheet title="New agent budget" onClose={onClose}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field id="agent-name" label="Agent name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="Coffee runner" />
        <Field id="agent-purpose" label="What it pays for (optional)" autoComplete="off" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Morning coffee orders" />
        <Field
          id="agent-limit"
          label="Budget in USDC"
          inputMode="decimal"
          autoComplete="off"
          value={limit}
          onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setLimit(e.target.value)}
          error={errors.limit}
          placeholder="50"
        />
        <fieldset>
          <legend className="text-[15px] font-medium text-ink-2">Resets every</legend>
          <div className="mt-2 inline-flex rounded-full bg-surface p-1">
            {(["day", "week", "month"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={per === p}
                onClick={() => setPer(p)}
                className={`h-10 rounded-full px-4 text-[15px] font-semibold capitalize ${per === p ? "bg-white shadow-sm" : "text-ink-2"} ${focusRing}`}
              >
                {p}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="pt-2">
          <PrimaryButton type="submit">Create budget</PrimaryButton>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------- Approval-gated actions (cancel, add method) ---------- */

function ApprovalSheet({
  title,
  description,
  methods,
  doneTitle,
  doneBody,
  onApproved,
  onClose,
}: {
  title: string;
  description: string;
  methods: MethodId[];
  doneTitle: string;
  doneBody: string;
  onApproved: (m: MethodId) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"choose" | "approving" | "done">("choose");
  const [method, setMethod] = useState<MethodId>(methods[0]);

  const go = async (m: MethodId) => {
    setMethod(m);
    setStep("approving");
    await requestApproval(m);
    onApproved(m);
    setStep("done");
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
      {step === "done" && <DoneView title={doneTitle} body={doneBody} onDone={onClose} />}
    </Sheet>
  );
}

export function CancelSheet({ pendingId, onClose }: { pendingId: string; onClose: () => void }) {
  const { state, removePending, addTx, removeCard } = useStore();
  const [p] = useState(() => state.pending.find((x) => x.id === pendingId));
  if (!p) return null;
  return (
    <ApprovalSheet
      title="Cancel this action?"
      description={`“${p.title}” will not run. ${p.cancelBy.length > 1 ? "Any of your methods can cancel it." : "Only World ID can cancel it."}`}
      methods={p.cancelBy.includes("faceid") ? ["faceid", "worldid"] : ["worldid"]}
      doneTitle="Cancelled"
      doneBody={`“${p.title}” won't run.`}
      onApproved={(m) => {
        removePending(p.id);
        if (p.cardId) removeCard(p.cardId);
        addTx({ kind: "cancelled", title: p.title, subtitle: `Cancelled with ${METHOD_LABEL[m]} · Just now`, amount: p.transfer?.amount, token: p.transfer?.token });
      }}
      onClose={onClose}
    />
  );
}
