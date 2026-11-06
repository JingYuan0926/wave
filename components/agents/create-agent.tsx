"use client";

import { useState } from "react";
import { ApproveFlow, requireMethod, type ApprovalRequest } from "@/components/approve-flow";
import { Button, Card, Field, Notice, SectionTitle, SelectField, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import { api } from "@/lib/api-client";
import type { Address, AgentsResponse } from "@/lib/api-types";
import { agentTier, limitError } from "@/lib/ui/agents";
import { parseTokenAmount } from "@/lib/ui/format";
import { findPasskey } from "@/lib/ui/local";
import { nameFor } from "@/lib/ui/rules";

export function CreateAgent({ data, onChanged }: { data: AgentsResponse; onChanged: () => void }) {
  const { account, info, tokenBy, offline, local, wallet } = useWallet();
  const [tokenAddress, setTokenAddress] = useState<string>(
    () => info?.tokens.find((token) => token.isTest)?.address ?? "",
  );
  const [perTransfer, setPerTransfer] = useState("");
  const [perDay, setPerDay] = useState("");
  const [askAbove, setAskAbove] = useState("");
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [created, setCreated] = useState<{ agent: Address; token: Address; askAbove: bigint } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const token = tokenBy(tokenAddress);
  if (!account || !info || !token) return null;

  const draft = { perTransfer, perDay };
  const limitProblem = perTransfer || perDay ? limitError(draft, token) : null;
  const ask = askAbove ? parseTokenAmount(askAbove, token.decimals) : null;
  const askValue = ask?.value ?? null;
  const ready = perTransfer !== "" && !limitProblem && askValue !== null;

  const start = () => {
    if (!data.next || askValue === null) return;
    const { address, salt } = data.next;
    setWarning(null);
    setCreated({ agent: address, token: token.address, askAbove: askValue });
    setRequest({
      action: {
        kind: "agent",
        agent: address,
        op: { kind: "create", salt, rules: [{ token: token.address, tiers: [agentTier(draft, token)] }] },
      },
      choices: requireMethod(account.methods, account.owner, info.world),
      method: account.owner,
    });
  };

  const ownerName = nameFor(
    account.owner,
    account.owner.kind === "passkey" && local && wallet ? findPasskey(local, wallet.address, account.owner.slot) : null,
    info.world,
  );

  const finish = async () => {
    setPerTransfer("");
    setPerDay("");
    setAskAbove("");
    onChanged();
    if (!created) return;
    try {
      await api.agentCheckpoint({ ...created, askAbove: created.askAbove.toString() });
    } catch {
      // No stored amount means that each spend asks a human, so this failure is safe.
      setWarning("WAVE could not save the approval amount. Every spend asks you until you set it in Limits.");
    }
    onChanged();
  };

  return (
    <Card>
      <SectionTitle hint="The same wallet as your main wallet, approved by your owner method. Your main wallet is its master.">
        Create an agent wallet
      </SectionTitle>
      <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <SelectField
          label="Token"
          name="agent-token"
          value={tokenAddress}
          onChange={(event) => setTokenAddress(event.target.value)}
        >
          {info.tokens.map((item) => (
            <option key={item.address} value={item.address}>
              {item.isTest ? item.name : item.symbol}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Per transfer"
            name="agent-per-transfer"
            value={perTransfer}
            onChange={(event) => setPerTransfer(event.target.value)}
            placeholder="0.00"
            autoComplete="off"
            inputMode="decimal"
          />
          <Field
            label="Per day"
            name="agent-per-day"
            value={perDay}
            onChange={(event) => setPerDay(event.target.value)}
            placeholder="No limit"
            autoComplete="off"
            inputMode="decimal"
          />
        </div>
        {limitProblem ? <p className="text-sm text-destructive">{limitProblem}</p> : null}
        <Field
          label="Ask a human above"
          name="agent-ask-above"
          value={askAbove}
          onChange={(event) => setAskAbove(event.target.value)}
          placeholder="0.00"
          autoComplete="off"
          inputMode="decimal"
          error={ask?.error ?? null}
          hint="Above this amount, the agent waits for a World ID login (Agent Pass). This needs World ID, also if your wallet has no World ID method."
        />
        <Button onClick={start} disabled={!ready || !data.next || !data.agentKey || offline}>
          Create with {ownerName}
        </Button>
      </form>
      {warning ? (
        <Notice tone="warning" title="Approval amount not saved" className="mt-3">
          {warning}
        </Notice>
      ) : null}
      {request ? (
        <Sheet title="Create agent wallet" onClose={() => setRequest(null)}>
          <ApproveFlow request={request} onDone={() => void finish()} />
        </Sheet>
      ) : null}
    </Card>
  );
}
