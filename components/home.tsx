"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { Activity } from "./activity";
import { CreateWallet } from "./create-wallet";
import { PendingActions } from "./pending-actions";
import { SendFlow } from "./send-flow";
import { Button } from "./ui";
import { WalletCard, WalletCardSkeleton } from "./wallet-card";
import { useWallet } from "./wallet-provider";
import { resetLocal } from "@/lib/ui/local";

/** Returns to the create screen, so a tester can run the create flow again. */
function StartOver() {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <div className="text-center">
        <Button variant="ghost" onClick={() => setAsking(true)}>
          Start over
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl border border-border p-4 text-sm">
      <p>
        This browser forgets this wallet, its test identity and its passkey IDs. Then you see the
        create screen again. With a test identity, you cannot get back into this wallet.
      </p>
      <div className="flex gap-2">
        <Button variant="danger" onClick={resetLocal}>
          Forget this wallet
        </Button>
        <Button variant="ghost" onClick={() => setAsking(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

export function Home() {
  const { local, wallet } = useWallet();
  // Next keeps this route hidden during a visit to Settings. A new key remounts
  // it, so a stale row with an enabled Execute button never shows.
  const { bfcacheId } = useRouter();
  const [sending, setSending] = useState(false);

  if (!local) return <WalletCardSkeleton />;
  if (!wallet) return <CreateWallet />;

  return (
    <Fragment key={bfcacheId}>
      <WalletCard onSend={() => setSending(true)} />
      <PendingActions />
      <Activity />
      <StartOver />
      {sending ? <SendFlow onClose={() => setSending(false)} /> : null}
    </Fragment>
  );
}
