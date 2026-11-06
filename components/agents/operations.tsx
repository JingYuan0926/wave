"use client";

import { Clock, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { DecodedLines } from "@/components/approve-flow";
import { REASONS } from "@/components/settings/agent-pass-card";
import { Badge, Button, Card, Notice, SectionTitle, focusRing } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { AgentOperationView, AgentPassAttempt } from "@/lib/api-types";
import { formatCountdown, shortHex } from "@/lib/ui/format";
import { explainRejection } from "@/lib/ui/rejections";
import { useNow } from "@/lib/ui/use-now";

const RECENT = 5;
const RESULT_POLL_MS = 2000;

function Countdown({ until }: { until: number }) {
  const now = useNow();
  if (now === 0) return null;
  return (
    <Badge>
      <Clock aria-hidden="true" className="size-3" />
      <span className="font-mono tabular-nums" role="timer">
        {formatCountdown(until / 1000 - now)}
      </span>
    </Badge>
  );
}

function ApprovalRow({ operation, configured }: { operation: AgentOperationView; configured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.agentPassApprove(operation.id);
      window.location.assign(authorizeUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not start the approval.");
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium">{operation.decoded.title}</p>
        <Countdown until={operation.expiresAt} />
      </div>
      <DecodedLines decoded={operation.decoded} />
      {operation.refusal ? (
        <Notice tone="warning" title="The last approval did not pass">
          {REASONS[operation.refusal.reason]}
        </Notice>
      ) : null}
      {error ? <Notice tone="danger" title="The approval did not start">{error}</Notice> : null}
      <Button onClick={() => void start()} disabled={busy || !configured}>
        {busy ? "Opening World ID…" : "Approve with World ID"}
      </Button>
    </li>
  );
}

/** Actions that wait for a person. Nothing in this list has run. */
export function HumanApprovals({
  operations,
  configured,
}: {
  operations: AgentOperationView[];
  configured: boolean;
}) {
  const waiting = operations.filter((operation) => operation.status === "needs-approval");
  if (waiting.length === 0) return null;
  return (
    <Card>
      <SectionTitle hint="Your agent asked for this. It does not run until you approve this exact action.">
        Needs human approval
      </SectionTitle>
      <ul className="flex flex-col gap-3">
        {waiting.map((operation) => (
          <ApprovalRow key={operation.id} operation={operation} configured={configured} />
        ))}
      </ul>
    </Card>
  );
}

const STATUS_BADGE = {
  sending: { tone: "neutral", text: "Sending" },
  done: { tone: "success", text: "Done" },
  failed: { tone: "danger", text: "Failed" },
  expired: { tone: "warning", text: "Expired" },
} as const;

function RecentRow({ operation }: { operation: AgentOperationView }) {
  if (operation.status === "needs-approval") return null;
  const badge = STATUS_BADGE[operation.status];
  const rejection = operation.rejection ? explainRejection(operation.rejection) : null;
  return (
    <li className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium">{operation.decoded.title}</p>
        <Badge tone={badge.tone} className="shrink-0">
          {badge.text}
        </Badge>
      </div>
      {rejection ? (
        <p className="text-sm text-muted-foreground">
          {rejection.title}. {rejection.detail}
        </p>
      ) : null}
      {operation.status === "expired" ? (
        <p className="text-sm text-muted-foreground">The 1-minute window ended. The action did not run.</p>
      ) : null}
      {operation.txHash && operation.explorerUrl ? (
        <a
          href={operation.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex min-h-10 w-fit items-center gap-1 rounded-lg font-mono text-sm underline tabular-nums ${focusRing}`}
        >
          {shortHex(operation.txHash, 10, 8)}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
    </li>
  );
}

export function RecentActions({ operations }: { operations: AgentOperationView[] }) {
  const ended = operations.filter((operation) => operation.status !== "needs-approval").slice(0, RECENT);
  if (ended.length === 0) return null;
  return (
    <Card>
      <SectionTitle hint="Actions that passed through the human checkpoint. A restart clears this list.">
        Recent approvals
      </SectionTitle>
      <ul className="flex flex-col gap-3">
        {ended.map((operation) => (
          <RecentRow key={operation.id} operation={operation} />
        ))}
      </ul>
    </Card>
  );
}

function readAttemptId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("agentpass");
}

/** The result of the World redirect. The server decided it, and this only shows it. */
export function ApprovalResult() {
  const [attemptId] = useState(readAttemptId);
  const [attempt, setAttempt] = useState<AgentPassAttempt | null>(null);

  useEffect(() => {
    if (!attemptId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      api
        .agentPassStatus(attemptId)
        .then((status) => {
          if (!active) return;
          setAttempt(status.attempt);
          // The server sends after the redirect, so the result comes a few seconds later.
          if (status.attempt?.status === "running") timer = setTimeout(read, RESULT_POLL_MS);
        })
        .catch(() => {
          // The action list still shows the state of the action.
        });
    };
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [attemptId]);

  if (attempt?.status === "running") {
    return <Notice title="World ID approved this">WAVE is sending the action now.</Notice>;
  }
  if (attempt?.status === "approved" && attempt.txHash && attempt.explorerUrl) {
    return (
      <Notice tone="success" title="World ID approved this, and the agent sent it">
        <a href={attempt.explorerUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-xs underline">
          {attempt.txHash}
        </a>
      </Notice>
    );
  }
  if (attempt?.status !== "failed" || !attempt.reason) return null;
  return (
    <Notice tone="warning" title="The approval did not pass">
      {REASONS[attempt.reason]}
    </Notice>
  );
}
