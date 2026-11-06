"use client";

import { useState } from "react";
import { api } from "@/lib/api-client";
import { CREATE_SIGNAL, type WorldProof, type WorldVerifyRequest } from "@/lib/api-types";
import { setWallet } from "@/lib/ui/local";
import { Card, Notice, Skeleton } from "./ui";
import { useWallet } from "./wallet-provider";
import { WorldScan } from "./world-scan";

export function CreateWallet() {
  const { info, offline } = useWallet();
  const [error, setError] = useState<string | null>(null);

  const finish = async (proof: WorldProof, raw: unknown) => {
    setError(null);
    const request: WorldVerifyRequest =
      info?.world.mode === "idkit" ? { source: "idkit", result: raw } : { source: "dev", proof };
    try {
      const verified = await api.worldVerify(request);
      setWallet({
        address: verified.address,
        ownerNullifierHash: verified.ownerNullifierHash,
        salt: verified.salt,
        rootHint: verified.merkleRoot,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not create the wallet.");
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Your wallet, approved by you</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          WAVE has no seed phrase and no separate signing key. You approve each action with
          World ID. Add passkeys later, and set your own limits and delays.
        </p>
      </div>
      {info ? (
        <WorldScan
          world={info.world}
          signal={CREATE_SIGNAL}
          label="Create wallet with World ID"
          disabled={offline}
          onProof={finish}
        />
      ) : (
        <Skeleton className="h-11" />
      )}
      {error ? <Notice tone="danger" title="WAVE could not create the wallet">{error}</Notice> : null}
    </Card>
  );
}
