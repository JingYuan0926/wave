"use client";

import { Banknote, Bot, Droplets, Pause, Play, ShieldOff, SlidersHorizontal, Terminal, Wallet } from "lucide-react";
import { useState } from "react";
import { ApproveFlow, anyMethod, requireMethod, type ApprovalRequest } from "@/components/approve-flow";
import { SendFlow } from "@/components/send-flow";
import { Amount, Badge, Button, Card, CopyHex, Field, Notice, SelectField, Sheet } from "@/components/ui";
import { CardFrame } from "@/components/wallet-card";
import { useWallet } from "@/components/wallet-provider";
import { api } from "@/lib/api-client";
import type { AgentAdminOp, AgentSpendResponse, AgentView, TokenInfo, TxAction } from "@/lib/api-types";
import {
  agentTier,
  aloneStep,
  aloneUnits,
  limitDraftOf,
  limitLines,
  limitSaveLine,
  limitShapeNote,
  limitsValid,
  tierSaveLine,
  type LimitDraft,
} from "@/lib/ui/agents";
import { parseTokenAmount } from "@/lib/ui/format";
import { explainAgentRejection } from "@/lib/ui/rejections";
import { compareRules, changeTiming } from "@/lib/ui/rules";
import { LimitFields } from "./limit-fields";

type Approve = (op: AgentAdminOp, who: "any" | "owner", note?: string) => void;

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
    const [sends, total] = limitLines(tier, ask, token);
    const note = limitShapeNote(tier, ask, token);
    return [
      <li key={token.address} className="flex flex-col">
        <span>{sends}</span>
        <span className="text-muted-foreground">{total}</span>
        {note ? <span className="text-muted-foreground">{note}</span> : null}
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
  const stored = askAboveOf(agent, token);
  const [draft, setDraft] = useState(() => limitDraftOf(tier, stored, token));
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = limitsValid(draft, token);
  const tiers = valid ? [agentTier(draft, token)] : null;
  const change = tiers && account ? compareRules(chain, tiers, token, account.methods, info?.world) : null;
  const direction = change?.direction ?? "same";
  const step = valid ? aloneStep(stored, aloneUnits(draft, token)) : "none";
  const timing = changeTiming(account?.waitSeconds ?? null, 172800);
  const line = limitSaveLine(step, direction, timing);
  const note = tier ? limitShapeNote(tier, stored, token) : null;

  const edit = (next: LimitDraft) => {
    setDraft(next);
    setSaved(null);
    setError(null);
  };

  /** The alone amount goes first. So no higher onchain limit can run with an old, higher alone amount. */
  const saveAlone = async (): Promise<string | null> => {
    if (step === "none") return null;
    const result = await api.agentCheckpoint({
      agent: agent.address,
      token: token.address,
      askAbove: aloneUnits(draft, token).toString(),
    });
    onChanged();
    return result.result === "applied"
      ? "The alone amount is saved."
      : "The higher alone amount waits in Needs human approval.";
  };

  const save = async () => {
    if (!tiers) return;
    setBusy(true);
    setSaved(null);
    setError(null);
    let aloneResult: string | null;
    try {
      aloneResult = await saveAlone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not save this amount.");
      return;
    } finally {
      setBusy(false);
    }
    const approveNote = [aloneResult, tierSaveLine(direction, timing)].filter((part) => part !== null).join(" ");
    if (direction === "stricter") approve({ kind: "tighten", token: token.address, tiers }, "any", approveNote);
    else if (direction === "looser") approve({ kind: "set-tiers", token: token.address, tiers }, "owner", approveNote);
    else setSaved(aloneResult);
  };

  return (
    <div className="flex flex-col gap-3">
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      <LimitFields draft={draft} token={token} onChange={edit} />
      {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
      <Button onClick={() => void save()} disabled={busy || !valid || line === null || saved !== null}>
        {busy ? "Saving…" : "Save"}
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
        This is above the amount that the agent sends alone. Nothing ran. Close this sheet and approve it with World ID.
      </Notice>
    );
  }
  if (result.result === "rejected") {
    const text = explainAgentRejection(result.rejection);
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
          The server signs as the agent with the demo key. Above the alone amount, you approve with World ID.
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

/** Saves this agent wallet for the local MCP tools. A tool cannot choose which wallet pays. */
function UseWithClaude({
  agent,
  used,
  disabled,
  onChanged,
}: {
  agent: AgentView;
  used: boolean;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.agentUseWithClaude(agent.address);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not save this agent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {used ? (
        <Notice tone="success" title="Claude Code uses this agent">
          Run /mcp in Claude Code, then ask for a payment. Above the alone amount, you approve with World ID.
        </Notice>
      ) : (
        <Button variant="secondary" onClick={() => void save()} disabled={busy || disabled}>
          <Terminal aria-hidden="true" className="size-4" />
          {busy ? "Saving…" : "Use with Claude Code"}
        </Button>
      )}
      {error ? <Notice tone="danger" title="This was not saved">{error}</Notice> : null}
    </div>
  );
}

type Panel = "fund" | "limits" | "withdraw" | "spend";

export function AgentCard({
  agent,
  name,
  usedByTools,
  onChanged,
}: {
  agent: AgentView;
  name: string;
  usedByTools: boolean;
  onChanged: () => void;
}) {
  const { account, info, tokenBy, offline } = useWallet();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  const [funding, setFunding] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);

  if (!account) return null;

  const faucet = async () => {
    setFunding(true);
    setFaucetError(null);
    try {
      await api.faucet(agent.address);
      onChanged();
    } catch (cause) {
      setFaucetError(cause instanceof Error ? cause.message : "The faucet failed.");
    } finally {
      setFunding(false);
    }
  };

  const approve: Approve = (op, who, note) => {
    const action: TxAction = { kind: "agent", agent: agent.address, op };
    const single = account.methods.length === 1 ? account.methods[0].ref : undefined;
    setPanel(null);
    setSheetKey((key) => key + 1);
    setRequest(
      who === "owner"
        ? { action, choices: requireMethod(account.methods, account.owner, info?.world), method: account.owner, note }
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
            // A sponsored wallet pays no gas, so ETH does not matter there.
            if (info?.gasSponsored && token.symbol === "ETH") return null;
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
          <Button
            variant="onCardGhost"
            className="col-span-2"
            onClick={faucet}
            disabled={offline || funding}
          >
            <Droplets aria-hidden="true" className="size-4" />
            {funding ? "Getting test USDC…" : "Get test USDC"}
          </Button>
        </div>
      </CardFrame>
      {faucetError ? <Notice tone="danger" title="The faucet failed">{faucetError}</Notice> : null}

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
                approve({ kind: "unpause" }, "owner", `Unpause needs the owner method. ${changeTiming(account.waitSeconds, 172800)}`)
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
                approve({ kind: "set-key" }, "owner", `A new key needs the owner method. ${changeTiming(account.waitSeconds, 172800)}`)
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
        <UseWithClaude
          agent={agent}
          used={usedByTools}
          disabled={offline || revoked || agent.paused || !agent.serverHoldsKey}
          onChanged={onChanged}
        />
      </Card>

      {panel === "fund" ? (
        <SendFlow
          initialTo={agent.address}
          onClose={() => {
            setPanel(null);
            onChanged();
          }}
        />
      ) : null}
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
