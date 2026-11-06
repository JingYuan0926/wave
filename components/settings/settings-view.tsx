"use client";

import Link from "next/link";
import { Button, Card, Skeleton } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import { AgentPassCard } from "./agent-pass-card";
import { Fallback } from "./fallback";
import { Methods } from "./methods";
import { RulesEditor } from "./rules-editor";
import { SecurityDemos } from "./security-demos";

export function SettingsView() {
  const { local, wallet, account, loading } = useWallet();

  if (!local || (wallet && !account && loading)) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">Create a wallet first.</p>
          <Link href="/">
            <Button className="w-full">Go to wallet</Button>
          </Link>
        </Card>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <Card>
          <p className="text-sm text-muted-foreground">
            WAVE cannot read this wallet now. Settings come back when the chain does.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <Methods />
      <RulesEditor />
      <Fallback />
      <SecurityDemos />
      <AgentPassCard />
    </div>
  );
}
