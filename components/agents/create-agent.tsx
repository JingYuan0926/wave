"use client";

import { useState } from "react";
import { ApproveFlow, anyMethod, type ApprovalRequest } from "@/components/approve-flow";
import { Button, Card, Notice, SectionTitle, SelectField, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import { api } from "@/lib/api-client";
import type { Address, AgentsResponse } from "@/lib/api-types";
import { agentTier, aloneUnits, limitsValid, type LimitDraft } from "@/lib/ui/agents";
import { findPasskey } from "@/lib/ui/local";
import { nameFor } from "@/lib/ui/rules";
import { LimitFields } from "./limit-fields";

const EMPTY_LIMITS: LimitDraft = { alone: "", perDay: "" };

export function CreateAgent({ data, onChanged }: { data: AgentsResponse; onChanged: () => void }) {
  const { account, info, tokenBy, offline, local, wallet } = useWallet();
  const [tokenAddress, setTokenAddress] = useState<string>(
    () => info?.tokens.find((token) => token.isTest)?.address ?? "",
  );
  const [draft, setDraft] = useState(EMPTY_LIMITS);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [created, setCreated] = useState<{ agent: Address; token: Address; askAbove: bigint } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const token = tokenBy(tokenAddress);
  if (!account || !info || !token) return null;

  const ready = limitsValid(draft, token);

  const start = () => {
    if (!data.next || !ready) return;
    const { address, salt } = data.next;
    setWarning(null);
    setCreated({ agent: address, token: token.address, askAbove: aloneUnits(draft, token) });
    setRequest({
      action: {
        kind: "agent",
        agent: address,
        op: { kind: "create", salt, rules: [{ token: token.address, tiers: [agentTier(draft, token)] }] },
      },
      choices: anyMethod(account.methods),
      method: account.owner,
    });
  };

  const ownerName = nameFor(
    account.owner,
    account.owner.kind === "passkey" && local && wallet ? findPasskey(local, wallet.address, account.owner.slot) : null,
    info.world,
  );

  const finish = async () => {
    setDraft(EMPTY_LIMITS);
    onChanged();
    if (!created) return;
    try {
      await api.agentCheckpoint({ ...created, askAbove: created.askAbove.toString() });
    } catch {
      // No stored amount means that a human approves each payment, so this failure is safe.
      setWarning("WAVE could not save the alone amount. You approve every payment until you set it in Limits.");
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
        <LimitFields draft={draft} token={token} onChange={setDraft} />
        <Button onClick={start} disabled={!ready || !data.next || !data.agentKey || offline}>
          Create with {ownerName}
        </Button>
      </form>
      {warning ? (
        <Notice tone="warning" title="Alone amount not saved" className="mt-3">
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
