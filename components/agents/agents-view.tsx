"use client";

import Link from "next/link";
import { Button, Card, Notice, Skeleton } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import type { Address } from "@/lib/api-types";
import { AgentCard } from "./agent-card";
import { CreateAgent } from "./create-agent";
import { ApprovalResult, HumanApprovals, RecentActions } from "./operations";
import { useAgents } from "./use-agents";

function Panel({ master }: { master: Address }) {
  const { data, error, refresh } = useAgents(master);
  const changed = () => void refresh();

  if (!data) {
    return error ? (
      <Notice tone="danger" title="WAVE cannot read the agent wallets" action={<Button variant="secondary" onClick={changed}>Try again</Button>}>
        {error}
      </Notice>
    ) : (
      <>
        <Skeleton className="h-52 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </>
    );
  }

  if (!data.supported) {
    return (
      <Notice tone="warning" title="This deployment has no agent wallets">
        Run npm run deploy in contracts/, then clear the site data of this page.
      </Notice>
    );
  }

  return (
    <>
      {error ? <Notice tone="warning" title="This list may be out of date">{error}</Notice> : null}
      {!data.agentKey ? (
        <Notice tone="warning" title="The demo agent key is not set">
          Set WAVE_AGENT_DEMO_KEY in .env.local, then restart the server.
        </Notice>
      ) : null}
      {!data.agentPassConfigured ? (
        <Notice tone="warning" title="Agent Pass is not configured">
          Actions above the approval amount stay blocked. There is no other way to approve them.
        </Notice>
      ) : null}
      <ApprovalResult />
      <HumanApprovals operations={data.operations} configured={data.agentPassConfigured} />
      {data.agents.map((agent, index) => (
        <AgentCard key={agent.address} agent={agent} name={`Agent ${index + 1}`} onChanged={changed} />
      ))}
      <RecentActions operations={data.operations} />
      <CreateAgent data={data} onChanged={changed} />
    </>
  );
}

export function AgentsView() {
  const { local, wallet, account, loading } = useWallet();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agent wallets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each agent has its own address, balance and limits. Your main wallet stays in control.
        </p>
      </div>
      {!local || (wallet && !account && loading) ? (
        <Skeleton className="h-52 rounded-2xl" />
      ) : !wallet ? (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Create a wallet first.</p>
          <Link href="/">
            <Button className="w-full">Go to wallet</Button>
          </Link>
        </Card>
      ) : !account ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            WAVE cannot read this wallet now. Agents come back when the chain does.
          </p>
        </Card>
      ) : (
        <Panel key={wallet.address} master={wallet.address} />
      )}
    </div>
  );
}
