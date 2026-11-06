"use client";

import { Banknote, Bot, Pause, Play, ShieldOff, SlidersHorizontal, Wallet } from "lucide-react";
import { useState } from "react";
import { ApproveFlow, anyMethod, requireMethod, type ApprovalRequest } from "@/components/approve-flow";
import { SendFlow } from "@/components/send-flow";
import { Amount, Badge, Button, Card, CopyHex, Field, Notice, SelectField, Sheet } from "@/components/ui";
import { CardFrame } from "@/components/wallet-card";
import { useWallet } from "@/components/wallet-provider";
import { api } from "@/lib/api-client";
import type { AgentAdminOp, AgentSpendResponse, AgentView, TokenInfo, TxAction } from "@/lib/api-types";
import { agentTier, limitError } from "@/lib/ui/agents";
import { formatAmount, parseTokenAmount, plainAmount } from "@/lib/ui/format";
import { explainRejection } from "@/lib/ui/rejections";
import { WORLD_ID, compareRules } from "@/lib/ui/rules";

type Approve = (op: AgentAdminOp, who: "any" | "world", note?: string) => void;

function TokenSelect({
  tokens,
  value,
  onChange,
}: {
  tokens: TokenInfo[];
  value: string;
  onChange: (address: string) => void;
}) {
  return (
    <SelectField label="Token" name="token" value={value} onChange={(event) => onChange(event.target.value)}>
      {tokens.map((item) => (
        <option key={item.address} value={item.address}>
          {item.isTest ? item.name : item.symbol}
        </option>
      ))}
    </SelectField>
  );
}

function defaultToken(tokens: TokenInfo[]): string {
  return tokens.find((token) => token.isTest)?.address ?? tokens[0]?.address ?? "";
}

function askAboveOf(agent: AgentView, token: TokenInfo): string | null {
  const entry = agent.askAbove.find((item) => item.token.toLowerCase() === token.address.toLowerCase());
  return entry ? entry.amount : null;
}

function LimitLines({ agent }: { agent: AgentView }) {
  const { info } = useWallet();
  const rows = (info?.tokens ?? []).flatMap((token) => {
    const rules = agent.rules.find((rule) => rule.token === token.address);
    const tier = rules?.tiers[0];
    if (!tier) return [];
    const ask = askAboveOf(agent, token);
    return [
      <li key={token.address} className="flex flex-col">
        <span>
          {plainAmount(tier.upTo, token.decimals)} {token.symbol} per transfer
          {BigInt(tier.cap) > BigInt(0) ? `, ${plainAmount(tier.cap, token.decimals)} per day` : ", no daily limit"}
        </span>
        {BigInt(tier.cap) > BigInt(0) ? (
          <span className="text-muted-foreground">
            {formatAmount(tier.spent, token.decimals)} {token.symbol} spent in this period
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {ask === null
            ? "Every spend asks you"
            : `Asks you above ${plainAmount(ask, token.decimals)} ${token.symbol}`}
        </span>
      </li>,
    ];
  });
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No limits are set, so this agent cannot spend.</p>;
  }
  return <ul className="flex flex-col gap-2 text-sm">{rows}</ul>;
}

function LimitsForm({
  agent,
  token,
  approve,
  onChanged,
}: {
  agent: AgentView;
  token: TokenInfo;
  approve: Approve;
  onChanged: () => void;
}) {
  const { info, account } = useWallet();
  const chain = agent.rules.find((rule) => rule.token === token.address)?.tiers ?? [];
  const tier = chain[0];
  const [perTransfer, setPerTransfer] = useState(tier ? plainAmount(tier.upTo, token.decimals) : "");
  const [perDay, setPerDay] = useState(
    tier && BigInt(tier.cap) > BigInt(0) ? plainAmount(tier.cap, token.decimals) : "",
  );
  const current = askAboveOf(agent, token);
  const [askAbove, setAskAbove] = useState(current === null ? "" : plainAmount(current, token.decimals));
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draft = { perTransfer, perDay };
  const problem = limitError(draft, token);
  const tiers = problem ? null : [agentTier(draft, token)];
  const change = tiers && account ? compareRules(chain, tiers, token, account.methods, info?.world) : null;
  const ask = askAbove ? parseTokenAmount(askAbove, token.decimals) : null;

  const saveLimits = () => {
    if (!tiers || !change) return;
    if (change.direction === "stricter") {
      approve({ kind: "tighten", token: token.address, tiers }, "any");
    } else {
      approve(
        { kind: "set-tiers", token: token.address, tiers },
        "world",
        "Looser limits need World ID and wait in the queue on the Wallet page.",
      );
    }
  };

  const saveAsk = async () => {
    if (ask?.value === undefined || ask.value === null) return;
    setBusy(true);
    setSaved(null);
    setError(null);
    try {
      const result = await api.agentCheckpoint({
        agent: agent.address,
        token: token.address,
        askAbove: ask.value.toString(),
      });
      setSaved(
        result.result === "applied"
          ? "Saved."
          : "A higher amount needs your approval. It waits in Needs human approval.",
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not save this amount.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Per transfer"
          name="limit-per-transfer"
          value={perTransfer}
          onChange={(event) => setPerTransfer(event.target.value)}
          autoComplete="off"
          inputMode="decimal"
        />
        <Field
          label="Per day"
          name="limit-per-day"
          value={perDay}
          onChange={(event) => setPerDay(event.target.value)}
          placeholder="No limit"
          autoComplete="off"
          inputMode="decimal"
        />
      </div>
      {perTransfer && problem ? <p className="text-sm text-destructive">{problem}</p> : null}
      {change && change.direction !== "same" ? (
        <Notice
          tone={change.direction === "looser" ? "warning" : "info"}
          title={change.direction === "looser" ? "Looser: World ID and a delay" : "Stricter: applies at once"}
        >
          {change.changes.join(" ")}
        </Notice>
      ) : null}
      <Button variant="secondary" onClick={saveLimits} disabled={!change || change.direction === "same"}>
        Save limits
      </Button>
      <Field
        label="Ask a human above"
        name="limit-ask-above"
        value={askAbove}
        onChange={(event) => setAskAbove(event.target.value)}
        autoComplete="off"
        inputMode="decimal"
        error={ask?.error ?? null}
        hint="The server enforces this amount, not the chain. A higher amount needs your approval."
      />
      <Button variant="secondary" onClick={() => void saveAsk()} disabled={busy || ask === null || ask.value === null}>
        {busy ? "Saving…" : "Save amount"}
      </Button>
      {saved ? <Notice>{saved}</Notice> : null}
      {error ? <Notice tone="danger" title="This was not saved">{error}</Notice> : null}
    </div>
  );
}

function LimitsSheet({
  agent,
  approve,
  onChanged,
  onClose,
}: {
  agent: AgentView;
  approve: Approve;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { info, tokenBy } = useWallet();
  const tokens = info?.tokens ?? [];
  const [tokenAddress, setTokenAddress] = useState(() => defaultToken(tokens));
  const token = tokenBy(tokenAddress);
  return (
    <Sheet title="Agent limits" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <TokenSelect tokens={tokens} value={tokenAddress} onChange={setTokenAddress} />
        {token ? (
          <LimitsForm key={token.address} agent={agent} token={token} approve={approve} onChanged={onChanged} />
        ) : null}
      </div>
    </Sheet>
  );
}

function WithdrawSheet({ agent, approve, onClose }: { agent: AgentView; approve: Approve; onClose: () => void }) {
  const { info, tokenBy } = useWallet();
  const tokens = info?.tokens ?? [];
  const [tokenAddress, setTokenAddress] = useState(() => defaultToken(tokens));
  const [amountText, setAmountText] = useState("");
  const token = tokenBy(tokenAddress);
  const balance = BigInt(agent.balances.find((item) => item.token === tokenAddress)?.amount ?? "0");
  const parsed = token && amountText ? parseTokenAmount(amountText, token.decimals) : null;
  const amount = parsed?.value ? parsed.value : null;
  const tooMuch = amount !== null && amount > balance;

  return (
    <Sheet title="Withdraw to main wallet" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <TokenSelect
          tokens={tokens}
          value={tokenAddress}
          onChange={(address) => {
            setTokenAddress(address);
            setAmountText("");
          }}
        />
        <Field
          label="Amount"
          name="withdraw-amount"
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
          placeholder="0.00"
          autoComplete="off"
          inputMode="decimal"
          error={parsed?.error ?? (tooMuch ? "This is more than the agent holds." : null)}
        />
        {token ? (
          <p className="text-sm text-muted-foreground">
            The agent holds <Amount value={balance.toString()} decimals={token.decimals} symbol={token.symbol} />
          </p>
        ) : null}
        <Button
          disabled={amount === null || tooMuch || !token}
          onClick={() => {
            if (amount !== null && token) {
              approve({ kind: "withdraw", token: token.address, amount: amount.toString() }, "any");
            }
          }}
        >
          Withdraw
        </Button>
      </form>
    </Sheet>
  );
}

function SpendResult({ result }: { result: AgentSpendResponse }) {
  if (result.result === "needs-approval") {
    return (
      <Notice tone="warning" title="Needs human approval">
        This is above the amount that the agent can spend alone. Nothing ran. Close this sheet and approve it.
      </Notice>
    );
  }
  if (result.result === "rejected") {
    const text = explainRejection(result.rejection);
    return (
      <Notice tone="danger" title={text.title}>
        {text.detail}
      </Notice>
    );
  }
  return (
    <Notice tone="success" title="The agent sent this">
      <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-xs underline">
        {result.txHash}
      </a>
    </Notice>
  );
}

/** The demo agent. The server signs with WAVE_AGENT_DEMO_KEY, and nothing signs in the browser. */
function SpendSheet({ agent, onChanged, onClose }: { agent: AgentView; onChanged: () => void; onClose: () => void }) {
  const { wallet, info, tokenBy } = useWallet();
  const tokens = info?.tokens ?? [];
  const [to, setTo] = useState<string>(wallet?.address ?? "");
  const [tokenAddress, setTokenAddress] = useState(() => defaultToken(tokens));
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentSpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = tokenBy(tokenAddress);
  const parsed = token && amountText ? parseTokenAmount(amountText, token.decimals) : null;
  const amount = parsed?.value ? parsed.value : null;

  const run = async () => {
    if (amount === null || !token) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      setResult(
        await api.agentSpend({
          agent: agent.address,
          token: token.address,
          to: to as `0x${string}`,
          amount: amount.toString(),
        }),
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent could not run.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Run the demo agent" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <p className="text-sm text-muted-foreground">
          The server signs as the agent with the demo key. Your limits and the human checkpoint apply.
        </p>
        <Field
          label="To"
          name="spend-to"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <Field
            label="Amount"
            name="spend-amount"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            placeholder="0.00"
            autoComplete="off"
            inputMode="decimal"
            error={parsed?.error ?? null}
          />
          <TokenSelect tokens={tokens} value={tokenAddress} onChange={setTokenAddress} />
        </div>
        <Button onClick={() => void run()} disabled={busy || amount === null || !to}>
          {busy ? "The agent is working…" : "Ask the agent to spend"}
        </Button>
        {result ? <SpendResult result={result} /> : null}
        {error ? <Notice tone="danger" title="The agent could not run">{error}</Notice> : null}
      </form>
    </Sheet>
  );
}

type Panel = "fund" | "limits" | "withdraw" | "spend";

export function AgentCard({
  agent,
  name,
  onChanged,
}: {
  agent: AgentView;
  name: string;
  onChanged: () => void;
}) {
  const { account, info, tokenBy, offline } = useWallet();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);

  if (!account) return null;

  const approve: Approve = (op, who, note) => {
    const action: TxAction = { kind: "agent", agent: agent.address, op };
    const single = account.methods.length === 1 ? account.methods[0].ref : undefined;
    setPanel(null);
    setSheetKey((key) => key + 1);
    setRequest(
      who === "world"
        ? { action, choices: requireMethod(account.methods, WORLD_ID, info?.world), method: WORLD_ID, note }
        : { action, choices: anyMethod(account.methods), method: single, note },
    );
  };

  const revoked = agent.signer === null;
  const state = revoked ? "Revoked" : agent.paused ? "Paused" : "Active";

  return (
    <section aria-label={name} className="flex flex-col gap-2">
      <CardFrame>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-white/70">{name}</p>
            <CopyHex value={agent.address} className="focus-visible:ring-white" />
          </div>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{state}</span>
        </div>
        <dl className="mt-3 flex flex-col gap-1">
          {agent.balances.map((balance) => {
            const token = tokenBy(balance.token);
            if (!token) return null;
            return (
              <div key={balance.token} className="flex items-baseline justify-between gap-3">
                <dt className="text-sm text-white/70">{token.isTest ? token.name : token.symbol}</dt>
                <dd>
                  <Amount value={balance.amount} decimals={token.decimals} symbol={token.symbol} className="text-xl font-semibold" />
                </dd>
              </div>
            );
          })}
        </dl>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button
            variant="onCard"
            onClick={() => setPanel("spend")}
            disabled={offline || revoked || agent.paused || !agent.serverHoldsKey}
          >
            <Bot aria-hidden="true" className="size-4" />
            Run agent
          </Button>
          <Button variant="onCardGhost" onClick={() => setPanel("fund")} disabled={offline}>
            <Wallet aria-hidden="true" className="size-4" />
            Fund
          </Button>
        </div>
      </CardFrame>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Limits</h2>
          <Badge tone={agent.identityLinked ? "success" : "neutral"}>
            {agent.identityLinked ? "Human linked" : "No human linked yet"}
          </Badge>
        </div>
        <LimitLines agent={agent} />
        {!revoked && !agent.serverHoldsKey ? (
          <Notice tone="warning" title="The server does not hold this agent's key">
            The demo agent cannot run. Set the right WAVE_AGENT_DEMO_KEY, or replace the key.
          </Notice>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setPanel("limits")}>
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            Limits
          </Button>
          <Button variant="secondary" onClick={() => setPanel("withdraw")}>
            <Banknote aria-hidden="true" className="size-4" />
            Withdraw
          </Button>
          {agent.paused ? (
            <Button
              variant="secondary"
              onClick={() =>
                approve({ kind: "unpause" }, "world", "Unpause needs World ID and waits in the queue on the Wallet page.")
              }
            >
              <Play aria-hidden="true" className="size-4" />
              Unpause
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => approve({ kind: "pause" }, "any")} disabled={revoked}>
              <Pause aria-hidden="true" className="size-4" />
              Pause
            </Button>
          )}
          {revoked ? (
            <Button
              variant="secondary"
              onClick={() =>
                approve({ kind: "set-key" }, "world", "A new key needs World ID and waits in the queue on the Wallet page.")
              }
            >
              Set a new key
            </Button>
          ) : (
            <Button variant="danger" onClick={() => approve({ kind: "revoke" }, "any")}>
              <ShieldOff aria-hidden="true" className="size-4" />
              Revoke key
            </Button>
          )}
        </div>
      </Card>

      {panel === "fund" ? <SendFlow initialTo={agent.address} onClose={() => setPanel(null)} /> : null}
      {panel === "limits" ? (
        <LimitsSheet agent={agent} approve={approve} onChanged={onChanged} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "withdraw" ? <WithdrawSheet agent={agent} approve={approve} onClose={() => setPanel(null)} /> : null}
      {panel === "spend" ? <SpendSheet agent={agent} onChanged={onChanged} onClose={() => setPanel(null)} /> : null}
      {request ? (
        <Sheet title="Approve" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} onDone={onChanged} />
        </Sheet>
      ) : null}
    </section>
  );
}
