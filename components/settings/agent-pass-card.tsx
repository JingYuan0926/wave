"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Notice, SectionTitle, Skeleton } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import { ApiError, api } from "@/lib/api-client";
import type { AgentPassAttempt, AgentPassReason, AgentPassStatusResponse } from "@/lib/api-types";
import { shortHex } from "@/lib/ui/format";

const LAST_ATTEMPT_KEY = "wave.agentpass.last";
const POLL_MS = 2000;

export const REASONS: Record<AgentPassReason, string> = {
  cancelled: "You cancelled at World ID. The action did not run.",
  expired: "The approval window ended. The action did not run.",
  identity_mismatch: "A different World ID signed in. This wallet is linked to another identity. The action did not run.",
  unsupported_assurance: "World ID did not give an accepted Orb result for this attempt. The action did not run.",
  invalid_token: "The response from World ID failed a check. The action did not run.",
  replayed: "This approval was used before, or the action ended. It ran nothing.",
  rate_limited: "World ID limits requests now. The action did not run. Wait, then ask for a new code.",
  provider_error: "World ID or the chain failed, so this attempt is a refusal.",
};

function readAttemptId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("agentpass") ?? window.localStorage.getItem(LAST_ATTEMPT_KEY);
  } catch {
    return null;
  }
}

function saveAttemptId(id: string) {
  try {
    window.localStorage.setItem(LAST_ATTEMPT_KEY, id);
  } catch {
    // The URL does not carry the ID until the callback. The attempt still works.
  }
}

function TxLink({ attempt }: { attempt: AgentPassAttempt }) {
  if (!attempt.txHash || !attempt.explorerUrl) return null;
  return (
    <a href={attempt.explorerUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      Transaction {shortHex(attempt.txHash)}
    </a>
  );
}

function Result({ attempt }: { attempt: AgentPassAttempt }) {
  if (attempt.status === "pending") {
    const time = new Date(attempt.expiresAt).toLocaleTimeString();
    return (
      <Notice title="Not approved yet">
        This attempt expires at {time}. If you closed the World page, it stays unapproved.
      </Notice>
    );
  }
  if (attempt.status === "running") {
    return <Notice title="Checking">The server is working on this attempt.</Notice>;
  }
  if (attempt.status === "approved") {
    return (
      <Notice tone="success" title="Approved: the demo action ran">
        <p>
          Every check passed. World ID identity {attempt.identity === "linked" ? "is now linked to this wallet" : "matches this wallet"}.
        </p>
        {attempt.acr ? <p className="break-all">acr: {attempt.acr}</p> : null}
        {attempt.amr ? <p>amr: {attempt.amr.join(", ")}</p> : null}
        <TxLink attempt={attempt} />
      </Notice>
    );
  }
  return (
    <Notice tone="danger" title={`Refused: ${attempt.reason ?? "unknown"}`}>
      {attempt.reason ? <p>{REASONS[attempt.reason]}</p> : null}
      {attempt.detail ? <p>{attempt.detail}</p> : null}
      <TxLink attempt={attempt} />
    </Notice>
  );
}

export function AgentPassCard() {
  const { wallet } = useWallet();
  const [status, setStatus] = useState<AgentPassStatusResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = readAttemptId();

    const load = async () => {
      try {
        const next = await api.agentPassStatus(id);
        if (stopped) return;
        setStatus(next);
        setMissing(Boolean(id) && !next.attempt);
        if (next.attempt?.status === "pending" || next.attempt?.status === "running") {
          timer = setTimeout(load, POLL_MS);
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof ApiError ? cause.message : "The status did not load.");
      }
    };
    void load();

    // The back button can restore a frozen page. A reload reads the new attempt.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  if (!wallet) return null;

  const approve = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await api.agentPassStart(wallet.address);
      saveAttemptId(started.attemptId);
      window.location.assign(started.authorizeUrl);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The approval did not start.");
      setStarting(false);
    }
  };

  return (
    <Card>
      <SectionTitle hint="A human approves one exact action with a new World ID login. This login needs World ID, also for a wallet that has no World ID method.">
        Agent approval (World ID Agent Pass)
      </SectionTitle>
      {!status ? (
        error ? <Notice tone="danger" title="Agent Pass status">{error}</Notice> : <Skeleton className="h-32" />
      ) : !status.configured ? (
        <Notice tone="warning" title="Agent Pass is not configured">
          Set AGENT_PASS_CLIENT_ID and AGENT_PASS_CLIENT_SECRET in .env.local. The action stays blocked, and there is no bypass.
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 rounded-xl bg-muted p-3 text-sm">
            <Badge className="self-start">Demo protected action</Badge>
            <p className="font-medium">Send 1 test USDC to this wallet:</p>
            <p className="break-all font-mono text-xs">{wallet.address}</p>
            <p className="text-muted-foreground">
              This is a stand-in until agent wallets connect. It runs only after every check passes.
            </p>
          </div>

          <p className="text-sm text-muted-foreground">
            Issuer: <span className="break-all font-mono text-xs text-foreground">{status.issuer}</span>. This is Agent Pass (OIDC), not IDKit.
          </p>

          {missing ? <Notice title="This attempt is gone">The server has no record of it. A restart clears all attempts.</Notice> : null}
          {status.attempt ? <Result attempt={status.attempt} /> : null}
          {error ? <Notice tone="danger" title="Agent Pass">{error}</Notice> : null}

          <Button disabled={starting} onClick={approve}>
            {starting ? "Opening World ID" : "Approve with World ID"}
          </Button>

          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Try a refused path:</span> close the World page or let it expire. The action stays unapproved.
          </p>
          {status.sandbox ? (
            <p className="text-sm text-muted-foreground">
              Sandbox identities are fake. A sandbox approval does not prove that a real person is Orb verified.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
