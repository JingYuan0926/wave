import { type FormEvent, type InputHTMLAttributes, useEffect, useMemo, useState } from "react";
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  Copy,
  CreditCard,
  Droplets,
  Gauge,
  Globe,
  type LucideIcon,
  Plus,
  ScanFace,
  ScanLine,
  Send,
  Users,
} from "lucide-react";
import {
  CONFIG_DELAY,
  agentTier,
  aloneUnits,
  anyMethod,
  rankChoices,
  api,
  changeTiming,
  errorText,
  limitProblems,
  ownerLimitName,
  ownerName,
  plainAmount,
  plainName,
  requireMethod,
  testToken,
  type Address,
  type Hex,
  type MethodChoice,
  type TxAction,
} from "../lib/wave";
import { useStore, useWaveApproval, type State } from "../store";
import type { Nav } from "../nav";
import { PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ApproveButtons, ApprovingView, TxLink } from "../components/Approving";
import { AddressQr } from "../components/AddressQr";

/* ---------- Receive (Add money / Request) ---------- */

export function ReceiveSheet({ onClose }: { onClose: () => void }) {
  const { state, refresh } = useStore();
  const { info } = state;
  const address = state.wallet.address;
  const token = testToken(info);
  const [copied, setCopied] = useState(false);
  const [faucet, setFaucet] = useState<{ state: "idle" | "busy" | "done" | "error"; text?: string; hashes?: Hex[] }>({
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
    const wallet = state.localWallet;
    if (!wallet) return;
    setFaucet({ state: "busy" });
    try {
      const { funded, txHashes } = await api.faucet(wallet.address);
      const got = funded.find((item) => item.token.toLowerCase() === token?.address.toLowerCase());
      const text = got && token ? `${plainAmount(got.amount, token.decimals)} test USDC reached your wallet.` : "The faucet funded your wallet.";
      setFaucet({ state: "done", text, hashes: txHashes });
      await refresh();
    } catch (cause) {
      setFaucet({ state: "error", text: `${errorText(cause, "The faucet failed.")} Nothing reached your wallet.` });
    }
  };

  return (
    <Sheet title="Receive money" onClose={onClose}>
      <p className="text-[15px] leading-relaxed text-ink-2">
        Send test USDC on the WAVE {info?.network === "local" ? "local network" : "devnet"} to this address.
        {info?.gasSponsored && " Your wallet needs no ETH: WAVE pays the gas."}
      </p>
      <div className="mt-4 rounded-[24px] bg-surface p-5">
        <AddressQr address={address} />
        <p className="mt-4 break-all text-center font-mono text-lg leading-relaxed">{address}</p>
      </div>
      <div className="mt-5 space-y-2">
        <PrimaryButton onClick={copy}>
          {copied ? <Check className="size-5" aria-hidden /> : <Copy className="size-5" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
        </PrimaryButton>
        <PrimaryButton tone="ghost" onClick={claim} disabled={!address || state.offline || faucet.state === "busy"}>
          <Droplets className="size-5" aria-hidden />
          {faucet.state === "busy" ? "Funding…" : "Get test USDC"}
        </PrimaryButton>
      </div>
      {faucet.text && (
        <p role="status" className={`mt-3 text-sm leading-snug ${faucet.state === "error" ? "font-semibold text-danger" : "text-ink-2"}`}>
          {faucet.text}
        </p>
      )}
      {faucet.hashes?.map((hash) => <TxLink key={hash} hash={hash} />)}
    </Sheet>
  );
}

/* ---------- Scan ---------- */

// SAMPLE: no WAVE function yet. WAVE has no QR payment scan.
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

// SAMPLE: no WAVE function yet. WAVE has no address book, so the name stays in this tab.
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

/** Why this wallet cannot make an agent now, or null if it can. */
function agentBlock({ account, agentData, info, offline }: State): string | null {
  if (!account || !agentData) return "Your agents have not loaded yet.";
  if (offline) return "The chain does not answer. Nothing can be created now.";
  if (!agentData.supported) return "This deployment has no agent wallets. Deploy the contracts again.";
  if (!agentData.agentKey) return "The agent key is not set. Set WAVE_AGENT_DEMO_KEY, then restart the server.";
  if (!agentData.next) return "WAVE has no address for a new agent.";
  return testToken(info) ? null : "WAVE has no test USDC on this network.";
}

const AMOUNT_TEXT = /^\d*\.?\d{0,2}$/;
/** The build waits for this pause in typing, so each key press does not build. */
const PREBUILD_PAUSE_MS = 500;
/** A new agent starts with this much test USDC, so a demo can pay at once. */
const AGENT_START_USDC = 100;

type UnderChoice = "none" | "world";
type OverChoice = "world" | "block";

const UNDER_CHOICES: { id: UnderChoice; name: string }[] = [
  { id: "none", name: "No approval" },
  { id: "world", name: "World ID in the CLI" },
];
const OVER_CHOICES: { id: OverChoice; name: string }[] = [
  { id: "world", name: "World ID in the CLI" },
  { id: "block", name: "Block it" },
];

/** A dropdown in the same pill as the limit boxes. */
function ChoicePill<T extends string>({
  label,
  icon: Icon,
  value,
  options,
  wide,
  onPick,
}: {
  label: string;
  icon: LucideIcon;
  value: T;
  options: { id: T; name: string }[];
  wide?: boolean;
  onPick: (id: T) => void;
}) {
  return (
    <span
      className={`relative flex h-12 min-w-0 items-center gap-2 rounded-full bg-white pl-3 ring-1 ring-line focus-within:ring-2 focus-within:ring-wave-deep ${
        wide ? "flex-1" : "max-w-[62%] shrink-0"
      }`}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <select
        aria-label={label}
        className="h-full w-full min-w-0 cursor-pointer appearance-none truncate bg-transparent pr-8 text-[15px] font-semibold outline-none"
        value={value}
        onChange={(event) => onPick(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 size-4 text-ink-2" aria-hidden />
    </span>
  );
}

/** The same steps as components/agents/create-agent.tsx. Pause and limits live on the agent. */
export function AddAgentSheet({ onClose }: { onClose: () => void }) {
  const { state, flagNewCard, nameAgent, notify, refresh } = useStore();
  const { account, agentData, info, local, localWallet } = state;
  const token = testToken(info);
  // SAMPLE: no WAVE function yet. WAVE stores no name. It stays in this tab.
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [alone, setAlone] = useState("");
  const [under, setUnder] = useState<UnderChoice>("none");
  const [over, setOver] = useState<OverChoice>("world");
  const [errors, setErrors] = useState<{ name?: string; limit?: string; alone?: string }>({});
  const [submitted, setSubmitted] = useState(false);

  const next = agentData?.next ?? null;
  const owner = account?.owner ?? null;
  // Any method can create an agent. The last method in the rank is the passkey, the quickest one.
  const method = account ? (rankChoices(anyMethod(account.methods), localWallet, local, info).at(-1)?.view.ref ?? owner) : null;

  // The action exists as soon as the limits are valid, so it can build while the person fills in the form.
  const plan = useMemo(() => {
    if (!token || !next) return null;
    const draft = { alone, perDay: limit };
    const problems = limitProblems(draft, token);
    if (problems.alone || problems.perDay) return null;
    const limitUnits = aloneUnits(draft, token).toString();
    if (over === "block" && limitUnits === "0") return null;
    // Block makes the limit an onchain maximum for one payment, so nobody can approve more.
    const tier = over === "block" ? { ...agentTier(draft, token), upTo: limitUnits } : agentTier(draft, token);
    const action: TxAction = {
      kind: "agent",
      agent: next.address,
      op: { kind: "create", salt: next.salt, rules: [{ token: token.address, tiers: [tier] }] },
    };
    // An alone amount of 0 makes World ID approve every payment.
    return { action, askAbove: under === "none" ? limitUnits : "0" };
    // A poll makes new objects, so these keys hold the plan still and no extra build runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.address, next?.address, next?.salt, alone, limit, under, over]);

  const onAccepted = async () => {
    if (!token || !next || !plan) return;
    nameAgent(next.address, { name: name.trim(), purpose: "" });
    flagNewCard(next.address);
    try {
      await api.agentCheckpoint({ agent: next.address, token: token.address, askAbove: plan.askAbove });
    } catch {
      // No stored amount means that a human approves each payment, so this failure is safe.
      notify("WAVE could not save the alone amount. You approve every payment until you set it on the /agents page.");
    }
    try {
      // This mints new test USDC. It does not take funds from the main wallet.
      await api.faucet(next.address, (BigInt(AGENT_START_USDC) * BigInt(10) ** BigInt(token.decimals)).toString());
    } catch {
      notify(`WAVE could not give this agent ${AGENT_START_USDC} test USDC. Open the agent and use Fund.`);
    }
    await refresh();
  };

  const approval = useWaveApproval(plan?.action ?? null, onAccepted);
  const { stage, prebuild } = approval;
  const blocked = agentBlock(state);

  // Builds in the background while this page is open, so Create goes straight to the device.
  const methodKey = JSON.stringify(method);
  useEffect(() => {
    if (!plan || !method || submitted || blocked) return;
    const timer = setTimeout(() => void prebuild(method), PREBUILD_PAUSE_MS);
    return () => clearTimeout(timer);
    // The key stands for the method, because each render makes a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, methodKey, submitted, blocked, prebuild]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked || !token || !account || !next || !method) return;
    const draft = { alone, perDay: limit };
    const problems = limitProblems(draft, token);
    const found: typeof errors = {};
    if (!name.trim()) found.name = "Give the agent a name";
    if (problems.perDay) found.limit = problems.perDay;
    if (problems.alone) found.alone = problems.alone;
    else if (over === "block" && aloneUnits(draft, token) === BigInt(0)) found.alone = "Enter an amount above 0.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setSubmitted(true);
    void approval.approveNow(method);
  };

  return (
    <Sheet title={stage.name === "done" ? "" : "New agent wallet"} onClose={onClose}>
      {submitted && stage.name !== "idle" && <ApprovingView approval={approval} onDone={onClose} doneTitle="Agent created" />}

      {submitted && stage.name === "idle" && account && (
        <div className="space-y-2">
          <ApproveButtons
            choices={anyMethod(account.methods)}
            onPick={(method) => void approval.approveNow(method)}
          />
        </div>
      )}

      {!submitted && (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field id="agent-name" label="Agent name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="Coffee runner" />
          <Field
            id="agent-limit"
            label="Most per day in USDC"
            inputMode="decimal"
            autoComplete="off"
            value={limit}
            onChange={(e) => AMOUNT_TEXT.test(e.target.value) && setLimit(e.target.value)}
            error={errors.limit}
            placeholder="50"
          />
          <fieldset>
            <legend className="text-[15px] font-medium text-ink-2">Resets every</legend>
            {/* SAMPLE: no WAVE function yet. Only 24 hours works, because agent limits mean one day. */}
            <div className="mt-2 inline-flex rounded-full bg-surface p-1">
              {["1 hour", "12 hours", "24 hours"].map((time) => {
                const real = time === "24 hours";
                return (
                  <button
                    key={time}
                    type="button"
                    aria-pressed={real}
                    disabled={!real}
                    className={`h-10 rounded-full px-4 text-[15px] font-semibold ${
                      real ? "bg-white shadow-sm" : "cursor-not-allowed text-muted opacity-60"
                    } ${focusRing}`}
                  >
                    {time}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-[15px] font-medium text-ink-2">Limit for each transaction</legend>
            <div className="mt-2 space-y-3">
              <div>
                <p className="text-sm font-medium text-muted">Up to this amount</p>
                <div className={`mt-1.5 flex h-16 items-center gap-2 rounded-2xl bg-surface pl-4 pr-2 ${errors.alone ? "ring-2 ring-danger" : ""}`}>
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <input
                      id="agent-alone"
                      aria-label="Agent can send alone up to"
                      aria-invalid={!!errors.alone}
                      className="min-w-[1ch] max-w-full bg-transparent text-xl font-bold outline-none placeholder:text-muted [field-sizing:content]"
                      size={Math.max(alone.length, 1)}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      value={alone}
                      onChange={(e) => AMOUNT_TEXT.test(e.target.value) && setAlone(e.target.value)}
                    />
                    <span className="shrink-0 text-sm font-semibold text-muted">{token?.symbol ?? "USDC"}</span>
                  </div>
                  <ChoicePill label="Approval up to the limit" icon={under === "none" ? Bot : Globe} value={under} options={UNDER_CHOICES} onPick={setUnder} />
                </div>
                {errors.alone && <p className="mt-1.5 text-sm font-semibold text-danger">{errors.alone}</p>}
              </div>
              <div>
                <p className="text-sm font-medium text-muted">Over this amount, approve with</p>
                <div className="mt-1.5 flex h-16 items-center rounded-2xl bg-surface px-2">
                  <ChoicePill wide label="Approval over the limit" icon={over === "world" ? Globe : Ban} value={over} options={OVER_CHOICES} onPick={setOver} />
                </div>
              </div>
            </div>
          </fieldset>
          {blocked && (
            <p role="alert" className="text-sm font-semibold leading-snug text-danger">
              {blocked}
            </p>
          )}
          <div className="pt-2">
            <PrimaryButton type="submit" disabled={!!blocked}>
              Create agent wallet
            </PrimaryButton>
          </div>
        </form>
      )}
    </Sheet>
  );
}

/* ---------- Approval-gated actions (cancel, run) ---------- */

function ApprovalSheet({
  title,
  description,
  action,
  choices,
  doneTitle,
  queuedBody,
  onClose,
}: {
  title: string;
  description: string;
  action: TxAction;
  choices: MethodChoice[];
  doneTitle: string;
  queuedBody?: string;
  onClose: () => void;
}) {
  const approval = useWaveApproval(action);
  const { stage } = approval;

  return (
    <Sheet title={stage.name === "done" ? "" : title} onClose={onClose}>
      {stage.name === "idle" ? (
        <>
          <p className="text-[15px] leading-relaxed text-ink-2">{description}</p>
          <div className="mt-5 space-y-2">
            <ApproveButtons choices={choices} onPick={(method) => void approval.approveNow(method)} />
          </div>
          {!choices.some((choice) => choice.allowed) && (
            <p role="alert" className="mt-3 text-sm font-semibold leading-snug text-danger">
              No method on this wallet can approve this. Nothing reached the chain.
            </p>
          )}
        </>
      ) : (
        <ApprovingView approval={approval} onDone={onClose} doneTitle={doneTitle} queuedBody={queuedBody} />
      )}
    </Sheet>
  );
}

/** The queued action, as the sheet opened it. It stays after the chain removes it from the queue. */
function usePendingAction(pendingId: string) {
  const { state } = useStore();
  const [action] = useState(() => state.account?.pending.find((x) => x.id === pendingId));
  return action;
}

export function CancelSheet({ pendingId, onClose }: { pendingId: string; onClose: () => void }) {
  const { state } = useStore();
  const { account, info, local, localWallet } = state;
  const p = usePendingAction(pendingId);
  if (!p || !account) return null;
  const owner = account.methods.find((view) => view.owner);
  const ownerOnly = p.cancelBy === "owner";
  const ownerName = owner ? plainName(owner, localWallet, local, info?.world) : "The owner method";
  return (
    <ApprovalSheet
      title="Cancel this action?"
      description={`“${p.decoded.title}” will not run. ${ownerOnly ? `Only ${ownerName} can cancel it.` : "Any of your methods can cancel it."}`}
      action={{ kind: "cancel", actionId: p.id }}
      choices={ownerOnly ? requireMethod(account.methods, account.owner, info?.world) : anyMethod(account.methods)}
      doneTitle="Cancelled"
      onClose={onClose}
    />
  );
}

/** Only a network with no gas sponsor comes here. On a sponsored network, Run now needs no approval. */
export function RunSheet({ pendingId, onClose }: { pendingId: string; onClose: () => void }) {
  const { account } = useStore().state;
  const p = usePendingAction(pendingId);
  if (!p || !account) return null;
  return (
    <ApprovalSheet
      title="Run this action?"
      description={`“${p.decoded.title}” runs now. Any of your methods can approve this.`}
      action={{ kind: "execute-scheduled", actionId: p.id }}
      choices={anyMethod(account.methods)}
      doneTitle="Applied"
      onClose={onClose}
    />
  );
}

/** The Switch on an agent. Pause is at once. Resume gives the agent its power back, so it needs the owner. */
export function AgentSwitchSheet({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { state } = useStore();
  const { account, info, local, localWallet: wallet } = state;
  // The sheet keeps the state it opened with, so a poll cannot change what the owner approves.
  const [agent] = useState(() => state.agents.find((a) => a.id === agentId));
  if (!agent || !account) return null;

  if (agent.resumeQueued) {
    return (
      <Sheet title="Resume is queued" onClose={onClose}>
        <p className="text-[15px] leading-relaxed text-ink-2">A resume of {agent.name} already waits in Payments.</p>
        <div className="mt-5">
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        </div>
      </Sheet>
    );
  }

  const pause = agent.active;
  const owner = ownerName(account, { wallet, local, info });
  return (
    <ApprovalSheet
      title={pause ? "Pause this agent?" : "Resume this agent?"}
      description={
        pause
          ? `${agent.name} stops at once and cannot spend. Any of your methods can approve this.`
          : `${agent.name} gets its power back. This needs ${owner}. ${changeTiming(account.waitSeconds, CONFIG_DELAY)}`
      }
      action={{ kind: "agent", agent: agentId as Address, op: { kind: pause ? "pause" : "unpause" } }}
      choices={pause ? anyMethod(account.methods) : requireMethod(account.methods, account.owner, info?.world)}
      doneTitle={pause ? "Paused" : "Resumed"}
      onClose={onClose}
    />
  );
}

/** The same rule as components/settings/rules-editor.tsx: any method tightens, and only the owner loosens. */
export function SaveLimitsSheet({
  action,
  how,
  onClose,
}: {
  action: TxAction;
  how: "stricter" | "looser";
  onClose: () => void;
}) {
  const { account, info, local, localWallet: wallet } = useStore().state;
  if (!account) return null;
  const stricter = how === "stricter";
  return (
    <ApprovalSheet
      title="Save limits"
      description={
        stricter
          ? "Any of your methods can approve this. It applies at once."
          : `${ownerLimitName(account, { wallet, local, info })} required. ${changeTiming(account.waitSeconds, CONFIG_DELAY)}`
      }
      action={action}
      choices={stricter ? anyMethod(account.methods) : requireMethod(account.methods, account.owner, info?.world)}
      doneTitle="Limits saved"
      queuedBody={`This has not run yet. ${changeTiming(account.waitSeconds, CONFIG_DELAY)} See it in Payments.`}
      onClose={onClose}
    />
  );
}
