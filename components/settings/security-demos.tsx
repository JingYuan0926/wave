"use client";

import { useState } from "react";
import { ApproveFlow, type ApprovalRequest } from "@/components/approve-flow";
import { Button, Card, SectionTitle, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import type { MethodRef } from "@/lib/api-types";
import { findPasskey, randomIdentity } from "@/lib/ui/local";
import { WORLD_ID } from "@/lib/ui/rules";

export function SecurityDemos() {
  const { account, info, offline, wallet, local } = useWallet();
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);

  if (!account || !info) return null;

  // Only a passkey on this browser can sign the attempt.
  const passkey = account.methods.find(
    (m) => m.ref.kind === "passkey" && wallet && local && findPasskey(local, wallet.address, m.ref.slot),
  );
  const open = (next: ApprovalRequest) => {
    setSheetKey((key) => key + 1);
    setRequest(next);
  };

  const stolenPasskey = (method: MethodRef) =>
    open({
      action: { kind: "demo-direct-install" },
      choices: [],
      method,
      expectRejection: true,
      expectCodes: ["SenderFrameNotAllowed"],
    });

  const differentHuman = () =>
    open({
      action: { kind: "demo-stranger" },
      choices: [],
      method: WORLD_ID,
      expectRejection: true,
      expectCodes: ["NullifierMismatch"],
      identity: info.world.mode === "dev" ? randomIdentity() : undefined,
    });

  return (
    <Card>
      <SectionTitle hint="Each test sends a real attempt. The account must reject it.">
        Security demos
      </SectionTitle>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Stolen passkey calls installModule</h3>
          <p className="text-sm text-muted-foreground">
            A thief tries to add a module with a stolen passkey, with no queue and no World ID.
          </p>
          <Button
            variant="secondary"
            disabled={!passkey || !account.deployed || offline}
            onClick={() => passkey && stolenPasskey(passkey.ref)}
          >
            Try it
          </Button>
          {!passkey ? (
            <p className="text-sm text-muted-foreground">Add a passkey on this browser to run this test.</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Different human</h3>
          <p className="text-sm text-muted-foreground">
            {info.world.mode === "dev"
              ? "A new test identity tries to approve a transfer from this wallet."
              : "Ask another person to scan. Their nullifier does not match the owner."}
          </p>
          <Button
            variant="secondary"
            disabled={!account.deployed || offline}
            onClick={differentHuman}
          >
            Try it
          </Button>
          {!account.deployed ? (
            <p className="text-sm text-muted-foreground">
              Send your first transfer to deploy the wallet, then run these tests.
            </p>
          ) : null}
        </div>
      </div>
      {request ? (
        <Sheet title="Security demo" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </Card>
  );
}
