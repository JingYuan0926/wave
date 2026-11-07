import { useEffect, useState, type ReactNode } from "react";
import { Check, Clock, Copy, ExternalLink, Terminal } from "lucide-react";
import type { Agent } from "../data";
import { shortAddr } from "../lib/format";
import {
  ApiError,
  REASONS,
  api,
  errorText,
  explainAgentRejection,
  formatCountdown,
  formatDuration,
  isWaiting,
  leftToday,
  operationsOf,
  parseTokenAmount,
  plainAmount,
  recipientProblem,
  testToken,
  tokenBalance,
  type Address,
  type AgentOperationView,
  type AgentPassDevice,
  type AgentSpendResponse,
  type AgentView,
  type TokenInfo,
  type TxAction,
} from "../lib/wave";
import { useAgentPolling, useNow, useSpendCheck, useStore, useWaveApproval } from "../store";
import { AgentLimit } from "../components/AgentLimit";
import { TextQr } from "../components/AddressQr";
import { ApproveButtons, ApprovingView, DecodedLines, TxLink } from "../components/Approving";
import { IconButton, PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ReviewRows, Stop } from "./SendSheet";

/** The same count as components/agents/operations.tsx. */
const RECENT = 5;
const AMOUNT_TEXT = /^\d*\.?\d{0,6}$/;

const unitsOf = (raw: string, token: TokenInfo | undefined) => {
  const parsed = token && raw ? parseTokenAmount(raw, token.decimals) : null;
  return { units: parsed?.value ? parsed.value : null, error: parsed?.error ?? null };
};

/* ---------- Small parts ---------- */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="text-[17px] font-bold">{title}</h3>
      {hint && <p className="mt-1 text-sm leading-snug text-muted">{hint}</p>}
      {children}
    </section>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-[20px] bg-warn-soft p-4 text-sm leading-snug text-ink-2">{children}</div>;
}

function AmountBox({
  id,
  label,
  symbol,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  symbol: string;
  value: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className={`mt-3 flex h-16 items-baseline gap-1.5 rounded-2xl bg-surface px-4 pt-4 focus-within:ring-2 focus-within:ring-wave-deep ${
        invalid ? "ring-2 ring-danger" : ""
      }`}
    >
      <input
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="min-w-0 flex-1 bg-transparent text-xl font-bold tabular-nums outline-none placeholder:text-muted"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        value={value}
        onChange={(event) => {
          const text = event.target.value.replace(",", ".");
          if (AMOUNT_TEXT.test(text)) onChange(text);
        }}
      />
      <span className="shrink-0 text-sm font-semibold text-muted">{symbol}</span>
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
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
    <div className="flex items-center justify-between gap-2">
      <p className="truncate font-mono text-sm text-ink-2">{shortAddr(address)}</p>
      <IconButton label={copied ? "Copied" : "Copy address"} icon={copied ? Check : Copy} onClick={() => void copy()} />
    </div>
  );
}

/* ---------- Fund ---------- */

/** The same send as the Fund button of components/agents/agent-card.tsx, with the main wallet rules. */
function useFund(to: Address, token: TokenInfo | undefined) {
  const { state } = useStore();
  const { account } = state;
  const [raw, setRaw] = useState("");
  // The action stays fixed from the review step on, so a poll cannot change what the owner approves.
  const [action, setAction] = useState<TxAction | null>(null);
  const approval = useWaveApproval(action);

  const { units, error } = unitsOf(raw, token);
  const check = useSpendCheck(token, units);
  const balance = account && token ? tokenBalance(account, token.address) : BigInt(0);
  const overBalance = units !== null && units > balance;
  const problem = error ?? (overBalance ? "This is more than your balance." : null) ?? check.stop ?? check.noMethod;
  const ready = !!check.rule && !problem && !state.offline;

  // The first method builds while the owner reads, so Approve goes straight to the device or the scan.
  const firstMethod = check.allowed[0]?.view.ref;
  const firstKey = JSON.stringify(firstMethod);
  const { prebuild, reset } = approval;
  useEffect(() => {
    if (action && firstMethod) void prebuild(firstMethod);
    // The key stands for the method, because each render makes a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, firstKey, prebuild]);

  return {
    raw,
    setRaw,
    units,
    balance,
    check,
    problem,
    ready,
    action,
    approval,
    review: () => {
      if (ready && token && units !== null) setAction({ kind: "transfer", token: token.address, to, amount: units.toString() });
    },
    back: () => {
      reset();
      setAction(null);
    },
    finish: () => {
      reset();
      setAction(null);
      setRaw("");
    },
  };
}

type Fund = ReturnType<typeof useFund>;

function FundForm({ fund, token }: { fund: Fund; token: TokenInfo }) {
  const { daily } = fund.check;
  const main = `Your balance: ${plainAmount(fund.balance, token.decimals)} ${token.symbol}`;
  return (
    <Section title="Fund">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          fund.review();
        }}
      >
        <AmountBox
          id="fund-amount"
          label="Amount to fund"
          symbol={token.symbol}
          value={fund.raw}
          invalid={!!fund.problem}
          describedBy="fund-help"
          onChange={fund.setRaw}
        />
        <p id="fund-help" className="mt-1.5 text-sm text-muted">
          {daily ? `${main} · ${leftToday(daily, token)}` : main}
        </p>
        {fund.problem && <Stop>{fund.problem}</Stop>}
        <div className="mt-3">
          <PrimaryButton type="submit" disabled={!fund.ready}>
            Fund
          </PrimaryButton>
        </div>
      </form>
    </Section>
  );
}

function FundReview({ fund, name, token }: { fund: Fund; name: string; token: TokenInfo }) {
  const { info } = useStore().state;
  const { allowed, nameOf, rule } = fund.check;
  return (
    <div>
      <p className="text-sm text-muted">{info?.gasSponsored ? "Total" : "You send"}</p>
      <p className="text-3xl font-bold tabular-nums tracking-tight">
        {plainAmount(fund.units, token.decimals)} {token.symbol}
      </p>
      <ReviewRows
        rows={[
          ["To", name],
          ["Gas", info?.gasSponsored ? "0 (Sponsored)" : "Paid by this wallet"],
          ["Methods required", allowed.map((choice) => nameOf(choice.view)).join(" or ")],
          ...(rule?.delay ? ([["Timing", `After ${formatDuration(rule.delay).toLowerCase()} · cancellable`]] as const) : []),
        ]}
      />
      {/* A poll can change the balance or the rules while this step is open. */}
      {!fund.ready && <Stop>{fund.problem ?? "This send can no longer run. Edit it first."}</Stop>}
      <div className="mt-5 space-y-2">
        {fund.ready && <ApproveButtons choices={allowed} onPick={(method) => void fund.approval.approveNow(method)} />}
        <PrimaryButton tone="ghost" onClick={fund.back}>
          Edit
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ---------- Use with Claude Code ---------- */

/** Saves this agent wallet for the local MCP tools. A tool cannot choose which wallet pays. */
function ClaudeSection({ agent, blocked }: { agent: AgentView; blocked: string | null }) {
  const { state, refreshAgents } = useStore();
  const toolAgent = state.agentData?.toolAgent ?? null;
  const linked = agent.address.toLowerCase() === toolAgent?.toLowerCase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.agentUseWithClaude(agent.address);
      await refreshAgents();
    } catch (cause) {
      setError(errorText(cause, "WAVE could not save this agent."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Use with Claude Code" hint={linked ? undefined : toolAgent ? "Claude Code uses another agent now." : "Claude Code has no agent yet."}>
      {linked ? (
        <div className="mt-3 rounded-[20px] bg-wave-soft p-4 text-sm leading-snug text-ink">
          <p className="font-semibold">Claude Code uses this agent.</p>
          <p className="mt-1">Run /mcp in Claude Code, then ask it to send a payment.</p>
        </div>
      ) : (
        <div className="mt-3">
          <PrimaryButton tone="ghost" disabled={busy || !!blocked} onClick={() => void save()}>
            <Terminal className="size-5" aria-hidden />
            {busy ? "Saving…" : "Use with Claude Code"}
          </PrimaryButton>
          {blocked && <p className="mt-1.5 text-sm text-muted">{blocked}</p>}
        </div>
      )}
      {error && <Stop>{error}</Stop>}
    </Section>
  );
}

/* ---------- Send from this app ---------- */

/** The text must not say that nothing was sent unless that is sure. */
function spendErrorText(cause: unknown) {
  const text = errorText(cause, "The agent could not run.");
  if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) return `${text} Nothing was sent.`;
  return `${text} WAVE cannot tell if this ran. Check the agent balance before you try again.`;
}

function SpendResult({ result }: { result: AgentSpendResponse }) {
  if (result.result === "needs-approval") {
    return (
      <Warn>
        <p className="font-semibold">Nothing ran yet.</p>
        <p className="mt-1">This is above the amount that the agent sends alone. Approve it at the top of this sheet.</p>
      </Warn>
    );
  }
  if (result.result === "rejected") {
    const text = explainAgentRejection(result.rejection);
    return <Stop>{`${text.title}. ${text.detail}`}</Stop>;
  }
  // Frames have a status only after the transaction is mined.
  const mined = result.frames.some((frame) => frame.status);
  return (
    <div className="mt-3 rounded-[20px] bg-wave-soft p-4" role="status">
      <p className="text-sm font-semibold">{mined ? "The agent sent this." : "The mempool took this. WAVE has no receipt yet."}</p>
      <TxLink hash={result.txHash} />
    </div>
  );
}

/** The same path as Run agent in components/agents/agent-card.tsx. The server signs, not the browser. */
function SendSection({ agent, token, blocked }: { agent: AgentView; token: TokenInfo; blocked: string | null }) {
  const { state, refresh } = useStore();
  const [to, setTo] = useState(state.wallet.address);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentSpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const address = to.trim();
  const toProblem = address ? recipientProblem(address, agent.address) : null;
  const { units, error: amountError } = unitsOf(raw, token);
  const ready = !!address && !toProblem && units !== null && !blocked && !busy;

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const next = await api.agentSpend({
        agent: agent.address,
        token: token.address,
        to: address as Address,
        amount: units.toString(),
      });
      setResult(next);
      if (next.result !== "rejected") setRaw("");
    } catch (cause) {
      setError(spendErrorText(cause));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <Section title="Send from this app" hint="The server signs as the agent. Above the alone amount, you approve with World ID.">
      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="agent-send-to" className="text-[15px] font-medium text-ink-2">
          To
        </label>
        <input
          id="agent-send-to"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Wallet address, 0x…"
          value={to}
          aria-invalid={!!toProblem}
          aria-describedby={toProblem ? "agent-send-to-error" : undefined}
          onChange={(event) => setTo(event.target.value)}
          className={`mt-2 h-13 w-full rounded-2xl bg-surface px-4 font-mono text-[15px] outline-none ring-wave-deep placeholder:font-sans placeholder:text-muted focus-visible:ring-2 ${
            toProblem ? "ring-2 ring-danger" : ""
          }`}
        />
        {toProblem && (
          <p id="agent-send-to-error" className="mt-1.5 text-sm font-semibold text-danger">
            {toProblem}
          </p>
        )}
        <AmountBox
          id="agent-send-amount"
          label="Amount to send"
          symbol={token.symbol}
          value={raw}
          invalid={!!amountError}
          onChange={setRaw}
        />
        {amountError && <p className="mt-1.5 text-sm font-semibold text-danger">{amountError}</p>}
        <div className="mt-3">
          <PrimaryButton type="submit" disabled={!ready}>
            {busy ? "The agent is working…" : "Send"}
          </PrimaryButton>
        </div>
        {blocked && <p className="mt-1.5 text-sm text-muted">{blocked}</p>}
      </form>
      {result && <SpendResult result={result} />}
      {error && <Stop>{error}</Stop>}
    </Section>
  );
}

/* ---------- Approvals: the same rules as components/agents/operations.tsx ---------- */

function Countdown({ until }: { until: number }) {
  const now = useNow(1000);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[13px] font-semibold text-ink-2">
      <Clock className="size-3.5" aria-hidden />
      <span className="font-mono tabular-nums" role="timer">
        {formatCountdown((until - now) / 1000)}
      </span>
    </span>
  );
}

/** The handoff to a phone. It needs no callback, so it needs no tunnel. */
function DeviceHandoff({ device }: { device: AgentPassDevice }) {
  const link = device.verificationUriComplete ?? device.verificationUri;
  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-[20px] bg-surface p-4 text-center text-sm leading-snug text-ink-2">
      <TextQr text={link} alt="QR code of the World ID link" />
      <p>Scan with World ID on your phone, or open this link and enter the code.</p>
      <p className="font-mono text-lg font-semibold tracking-widest text-ink">{device.userCode}</p>
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex max-w-full items-center gap-1 rounded break-all font-mono text-xs underline underline-offset-2 ${focusRing}`}
      >
        {link}
        <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      </a>
      <p className="text-muted">Waiting for World ID. World does not show the payment. WAVE shows it next.</p>
    </div>
  );
}

function useDecision(operation: AgentOperationView) {
  const { refresh } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (name: string, step: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await step();
    } catch (cause) {
      setError(errorText(cause, "WAVE could not do this step."));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return {
    busy,
    error,
    start: () => run("start", () => api.agentPassDevice(operation.id)),
    // The token lives for this click only. The server gives it to this page, not to the MCP tools.
    confirm: () =>
      run("confirm", async () => {
        const { confirmToken } = await api.agentConfirmToken(operation.id);
        await api.agentDecision({ operationId: operation.id, decision: "confirm", confirmToken });
      }),
    reject: () => run("reject", () => api.agentDecision({ operationId: operation.id, decision: "reject" })),
  };
}

function RowFrame({ operation, state, children }: { operation: AgentOperationView; state: string; children: ReactNode }) {
  return (
    <li className="rounded-[24px] p-4 ring-1 ring-line">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-warn">{state}</p>
          <p className="mt-0.5 text-[15px] font-semibold">{operation.decoded.title}</p>
        </div>
        <Countdown until={operation.expiresAt} />
      </div>
      <DecodedLines lines={operation.decoded.lines} />
      {operation.decoded.warning && <Warn>{operation.decoded.warning}</Warn>}
      {children}
    </li>
  );
}

function ApprovalRow({ operation, configured }: { operation: AgentOperationView; configured: boolean }) {
  const { busy, error, start, reject } = useDecision(operation);
  return (
    <RowFrame operation={operation} state="Waiting for World ID">
      {operation.refusal && (
        <Warn>
          <p className="font-semibold">The last approval did not pass.</p>
          <p className="mt-1">{REASONS[operation.refusal.reason]}</p>
          <p className="mt-1">{operation.refusal.detail}</p>
        </Warn>
      )}
      {error && <Stop>{error}</Stop>}
      {operation.device && <DeviceHandoff device={operation.device} />}
      <div className="mt-3 space-y-2">
        {!operation.device && (
          <PrimaryButton onClick={() => void start()} disabled={busy !== null || !configured}>
            {busy === "start" ? "Asking World ID…" : "Approve with World ID"}
          </PrimaryButton>
        )}
        <PrimaryButton tone="ghost" onClick={() => void reject()} disabled={busy !== null}>
          Reject
        </PrimaryButton>
      </div>
    </RowFrame>
  );
}

function ConfirmRow({ operation }: { operation: AgentOperationView }) {
  const { busy, error, confirm, reject } = useDecision(operation);
  return (
    <RowFrame operation={operation} state="Authenticated, confirm the payment">
      <p className="mt-3 text-sm leading-snug text-ink-2">
        {operation.identity === "first"
          ? "This is the first approval for this agent wallet. Confirm links this World ID to it."
          : "This World ID matches the owner linked to this agent wallet."}{" "}
        It runs once, under the onchain rules of the wallet.
      </p>
      {error && <Stop>{error}</Stop>}
      <div className="mt-3 space-y-2">
        <PrimaryButton onClick={() => void confirm()} disabled={busy !== null}>
          {busy === "confirm" ? "Sending…" : "Confirm"}
        </PrimaryButton>
        <PrimaryButton tone="ghost" onClick={() => void reject()} disabled={busy !== null}>
          Reject
        </PrimaryButton>
      </div>
    </RowFrame>
  );
}

/** Actions that wait for a person. Nothing in this list has run. */
function Approvals({ operations, configured }: { operations: AgentOperationView[]; configured: boolean }) {
  if (operations.length === 0) return null;
  return (
    <Section title="Needs your approval" hint="Your agent asked for this. It does not run until you pass World ID and confirm this exact action.">
      {!configured && <Warn>Agent Pass is not configured. Payments above the alone amount stay blocked.</Warn>}
      <ul className="mt-3 space-y-3">
        {operations.map((operation) =>
          operation.status === "needs-confirmation" ? (
            <ConfirmRow key={operation.id} operation={operation} />
          ) : (
            <ApprovalRow key={operation.id} operation={operation} configured={configured} />
          ),
        )}
      </ul>
    </Section>
  );
}

const STATUS = {
  sending: { text: "Sending", tone: "bg-surface-2 text-ink-2" },
  done: { text: "Done", tone: "bg-wave-soft text-ink" },
  failed: { text: "Not sent", tone: "bg-danger-soft text-danger" },
  rejected: { text: "Rejected", tone: "bg-surface-2 text-ink-2" },
  unknown: { text: "Result unknown", tone: "bg-warn-soft text-warn" },
  expired: { text: "Expired", tone: "bg-warn-soft text-warn" },
} as const;

function RecentRow({ operation }: { operation: AgentOperationView }) {
  const badge = STATUS[operation.status as keyof typeof STATUS];
  const rejection = operation.rejection ? explainAgentRejection(operation.rejection) : null;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[15px] font-semibold">{operation.decoded.title}</p>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold ${badge.tone}`}>{badge.text}</span>
      </div>
      {rejection && (
        <p className="mt-1 text-sm leading-snug text-muted">
          {rejection.title}. {rejection.detail}
        </p>
      )}
      {operation.status === "expired" && <p className="mt-1 text-sm leading-snug text-muted">The approval window ended. The action did not run.</p>}
      {operation.status === "rejected" && <p className="mt-1 text-sm leading-snug text-muted">You rejected this. The action did not run.</p>}
      {operation.status === "unknown" && (
        <p className="mt-1 text-sm leading-snug text-muted">
          WAVE cannot tell if this ran. It stays blocked, and WAVE will not send it again. Check the agent balance.
        </p>
      )}
      {operation.txHash && <TxLink hash={operation.txHash} />}
    </li>
  );
}

function RecentActions({ operations }: { operations: AgentOperationView[] }) {
  if (operations.length === 0) return null;
  return (
    <Section title="Recent approvals" hint="A restart clears this list, except a send with an unknown result.">
      <ul className="mt-3 divide-y divide-line">
        {operations.map((operation) => (
          <RecentRow key={operation.id} operation={operation} />
        ))}
      </ul>
    </Section>
  );
}

/* ---------- The sheet ---------- */

/** Why this agent cannot spend now, or null if it can. The server checks this again. */
function spendBlock(agent: Agent, offline: boolean): string | null {
  if (offline) return "The chain does not answer. Nothing can be sent now.";
  if (agent.state === "revoked") return "The agent key is revoked, so this agent cannot spend.";
  if (agent.state === "paused") return "This agent is paused, so it cannot spend.";
  return agent.warning ?? null;
}

function AgentBody({
  agent,
  view,
  stale,
  onClose,
}: {
  agent: Agent;
  view: AgentView;
  stale: string | null;
  onClose: () => void;
}) {
  const { state } = useStore();
  const { agentData, info, offline } = state;
  const token = testToken(info);
  const fund = useFund(view.address, token);
  const { stage } = fund.approval;

  const operations = operationsOf(agentData, view.address);
  const held = token ? view.balances.find((item) => item.token.toLowerCase() === token.address.toLowerCase()) : undefined;
  const blocked = spendBlock(agent, offline);
  const funding = fund.action !== null;
  const title = !funding
    ? agent.name
    : stage.name === "done"
      ? ""
      : stage.name === "idle" || stage.name === "sign"
        ? "Check and approve"
        : `Fund ${agent.name}`;

  return (
    <Sheet title={title} onClose={onClose}>
      {funding && stage.name !== "idle" && <ApprovingView approval={fund.approval} onDone={fund.finish} />}
      {funding && stage.name === "idle" && token && <FundReview fund={fund} name={`${agent.name} · ${shortAddr(view.address)}`} token={token} />}

      {/* The forms stay mounted, so a Fund step does not clear what the person typed. */}
      <div hidden={funding}>
        <div className="rounded-[24px] bg-surface p-4">
          <CopyAddress address={view.address} />
          <p className="mt-2 text-sm text-muted">Balance</p>
          <p className="text-3xl font-bold tabular-nums tracking-tight">
            {token && held ? `${plainAmount(held.amount, token.decimals)} ${token.symbol}` : "--"}
          </p>
          <div className="mt-3">
            <AgentLimit agent={agent} />
          </div>
        </div>

        {stale && <Warn>This list may be out of date. {stale}</Warn>}

        <Approvals operations={operations.filter(isWaiting)} configured={!!agentData?.agentPassConfigured} />

        {token ? <FundForm fund={fund} token={token} /> : <Stop>WAVE has no test USDC on this network, so nothing can be sent.</Stop>}
        <ClaudeSection agent={view} blocked={blocked} />
        {token && <SendSection agent={view} token={token} blocked={blocked} />}
        <RecentActions operations={operations.filter((operation) => !isWaiting(operation)).slice(0, RECENT)} />
      </div>
    </Sheet>
  );
}

/** All that a person needs to use one agent, with no need for the /agents page. */
export function AgentSheet({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { state } = useStore();
  const stale = useAgentPolling();
  const agent = state.agents.find((item) => item.id === agentId);
  const view = state.agentData?.agents.find((item) => item.address === agentId);

  if (!agent || !view) {
    return (
      <Sheet title="Agent" onClose={onClose}>
        <p className="text-[15px] leading-relaxed text-ink-2">WAVE cannot read this agent now.</p>
        {stale && <Stop>{stale}</Stop>}
      </Sheet>
    );
  }
  return <AgentBody agent={agent} view={view} stale={stale} onClose={onClose} />;
}
