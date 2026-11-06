"use client";

import { Clock, ExternalLink } from "lucide-react";
import Image from "next/image";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { DecodedLines } from "@/components/approve-flow";
import { REASONS } from "@/components/settings/agent-pass-card";
import { Badge, Button, Card, Notice, SectionTitle, Skeleton, focusRing } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { AgentOperationView, AgentPassDevice } from "@/lib/api-types";
import { formatCountdown, shortHex } from "@/lib/ui/format";
import { explainAgentRejection } from "@/lib/ui/rejections";
import { useNow } from "@/lib/ui/use-now";

const RECENT = 5;

const isWaiting = ({ status }: AgentOperationView) => status === "needs-approval" || status === "needs-confirmation";

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

function DeviceQr({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    QRCode.toString(value, { type: "svg", margin: 2, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (active) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        // The code and the link stay on the page.
      });
    return () => {
      active = false;
    };
  }, [value]);

  if (!src) return <Skeleton className="size-44 rounded-xl" />;
  return <Image unoptimized src={src} alt="QR code of the World ID link" width={176} height={176} className="rounded-xl" />;
}

/** The handoff to a phone. It needs no callback, so it needs no tunnel. */
function DeviceHandoff({ device }: { device: AgentPassDevice }) {
  const link = device.verificationUriComplete ?? device.verificationUri;
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-muted p-3 text-center text-sm">
      <DeviceQr value={link} />
      <p className="text-muted-foreground">Scan with World ID on your phone, or open this link and enter the code.</p>
      <p className="font-mono text-lg font-semibold tracking-widest">{device.userCode}</p>
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className={`inline-flex min-h-10 max-w-full items-center gap-1 rounded-lg font-mono text-xs break-all underline ${focusRing}`}
      >
        {link}
        <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
      </a>
      <p className="text-muted-foreground">Waiting for World ID. World does not show the payment. WAVE shows it next.</p>
    </div>
  );
}

function useDecision(operation: AgentOperationView, onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (name: string, step: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await step();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not do this step.");
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return {
    busy,
    error,
    start: () => run("start", () => api.agentPassDevice(operation.id)),
    // The token lives for this click only. The server gives it to this page, not to the MCP tools.
    confirm: () =>
      run("confirm", async () => {
        const { confirmToken } = await api.agentConfirmToken(operation.id);
        await api.agentDecision({ operationId: operation.id, decision: "confirm", confirmToken });
      }),
    reject: () => run("reject", () => api.agentDecision({ operationId: operation.id, decision: "reject" })),
  };
}

function ApprovalRow({
  operation,
  configured,
  onChanged,
}: {
  operation: AgentOperationView;
  configured: boolean;
  onChanged: () => void;
}) {
  const { busy, error, start, reject } = useDecision(operation, onChanged);

  return (
    <li className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium">{operation.decoded.title}</p>
        <Countdown until={operation.expiresAt} />
      </div>
      <DecodedLines decoded={operation.decoded} />
      {operation.refusal ? (
        <Notice tone="warning" title="The last approval did not pass">
          <p>{REASONS[operation.refusal.reason]}</p>
          <p>{operation.refusal.detail}</p>
        </Notice>
      ) : null}
      {error ? <Notice tone="danger" title="This step did not work">{error}</Notice> : null}
      {operation.device ? <DeviceHandoff device={operation.device} /> : null}
      <div className="flex flex-wrap gap-2">
        {operation.device ? null : (
          <Button className="flex-1" onClick={() => void start()} disabled={busy !== null || !configured}>
            {busy === "start" ? "Asking World ID…" : "Approve with World ID"}
          </Button>
        )}
        <Button className="flex-1" variant="secondary" onClick={() => void reject()} disabled={busy !== null}>
          Reject
        </Button>
      </div>
    </li>
  );
}

function ConfirmRow({ operation, onChanged }: { operation: AgentOperationView; onChanged: () => void }) {
  const { busy, error, confirm, reject } = useDecision(operation, onChanged);

  return (
    <li className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge tone="success">Authenticated, confirm the payment</Badge>
          <p className="mt-1 text-sm font-medium">{operation.decoded.title}</p>
        </div>
        <Countdown until={operation.expiresAt} />
      </div>
      <DecodedLines decoded={operation.decoded} />
      <p className="text-sm text-muted-foreground">
        {operation.identity === "first"
          ? "This is the first approval for this agent wallet. Confirm links this World ID to it."
          : "This World ID matches the owner linked to this agent wallet."}{" "}
        It runs once, under the onchain rules of the wallet.
      </p>
      {error ? <Notice tone="danger" title="This step did not work">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="flex-1" onClick={() => void confirm()} disabled={busy !== null}>
          {busy === "confirm" ? "Sending…" : "Confirm"}
        </Button>
        <Button className="flex-1" variant="secondary" onClick={() => void reject()} disabled={busy !== null}>
          Reject
        </Button>
      </div>
    </li>
  );
}

/** Actions that wait for a person. Nothing in this list has run. */
export function HumanApprovals({
  operations,
  configured,
  onChanged,
}: {
  operations: AgentOperationView[];
  configured: boolean;
  onChanged: () => void;
}) {
  const waiting = operations.filter(isWaiting);
  if (waiting.length === 0) return null;
  return (
    <Card>
      <SectionTitle hint="Your agent asked for this. It does not run until you pass World ID and confirm this exact action.">
        Needs human approval
      </SectionTitle>
      <ul className="flex flex-col gap-3">
        {waiting.map((operation) =>
          operation.status === "needs-confirmation" ? (
            <ConfirmRow key={operation.id} operation={operation} onChanged={onChanged} />
          ) : (
            <ApprovalRow key={operation.id} operation={operation} configured={configured} onChanged={onChanged} />
          ),
        )}
      </ul>
    </Card>
  );
}

const STATUS_BADGE = {
  sending: { tone: "neutral", text: "Sending" },
  done: { tone: "success", text: "Done" },
  failed: { tone: "danger", text: "Not sent" },
  rejected: { tone: "neutral", text: "Rejected" },
  unknown: { tone: "warning", text: "Result unknown" },
  expired: { tone: "warning", text: "Expired" },
} as const;

function RecentRow({ operation }: { operation: AgentOperationView }) {
  if (isWaiting(operation)) return null;
  const badge = STATUS_BADGE[operation.status as keyof typeof STATUS_BADGE];
  const rejection = operation.rejection ? explainAgentRejection(operation.rejection) : null;
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
        <p className="text-sm text-muted-foreground">The approval window ended. The action did not run.</p>
      ) : null}
      {operation.status === "rejected" ? (
        <p className="text-sm text-muted-foreground">You rejected this. The action did not run.</p>
      ) : null}
      {operation.status === "unknown" ? (
        <p className="text-sm text-muted-foreground">
          WAVE cannot tell if this ran. It stays blocked, and WAVE will not send it again. Check the wallet activity.
        </p>
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
  const ended = operations.filter((operation) => !isWaiting(operation)).slice(0, RECENT);
  if (ended.length === 0) return null;
  return (
    <Card>
      <SectionTitle hint="Actions that passed through the human checkpoint. A restart clears this list, except a send with an unknown result.">
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
