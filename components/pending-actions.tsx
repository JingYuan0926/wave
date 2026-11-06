"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api-client";
import type { Hex, MethodRef, PendingAction } from "@/lib/api-types";
import { formatCountdown, formatDuration } from "@/lib/ui/format";
import { methodLabel, recoveryChoices, sameMethod } from "@/lib/ui/rules";
import { useNow } from "@/lib/ui/use-now";
import { ApproveFlow, DecodedLines, anyMethod, requireMethod, type ApprovalRequest } from "./approve-flow";
import { Badge, Button, Card, CopyHex, Notice, SectionTitle, Sheet, Skeleton } from "./ui";
import { useWallet } from "./wallet-provider";

function Countdown({ until }: { until: number }) {
  const now = useNow();
  if (now === 0) return <span className="font-mono tabular-nums">--</span>;
  return (
    <span className="font-mono tabular-nums" role="timer">
      {formatCountdown(until - now)}
    </span>
  );
}

function delayText(action: PendingAction): string {
  const applied = formatDuration(action.appliedDelay).toLowerCase();
  const real = formatDuration(action.realDelay).toLowerCase();
  return action.appliedDelay < action.realDelay ? `Wait: ${applied}` : `Delay: ${real}`;
}

type OpenRequest = Omit<ApprovalRequest, "choices"> & { only?: MethodRef; choices?: ApprovalRequest["choices"] };

function Row({
  action,
  onApprove,
  onRan,
  approveChoices,
}: {
  action: PendingAction;
  onApprove: (request: OpenRequest) => void;
  onRan: (hash: Hex) => void;
  approveChoices: ApprovalRequest["choices"];
}) {
  const { account, info, wallet, refresh } = useWallet();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // The owner approved this when it was queued. So on the local network it needs no new scan.
  const execute = async () => {
    if (!info?.gasSponsored || !wallet) {
      onApprove({ action: { kind: "execute-scheduled", actionId: action.id } });
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const { txHash } = await api.runScheduled({ account: wallet.address, actionId: action.id });
      onRan(txHash);
      await refresh();
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : "WAVE could not run this action.");
    } finally {
      setRunning(false);
    }
  };
  const now = useNow();
  const over = action.executeAfter !== null && now !== 0 && now >= action.executeAfter;
  const canRun = action.status === "ready" || (action.status === "waiting" && over);

  return (
    <li className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{action.decoded.title}</p>
          <p className="text-sm text-muted-foreground">
            Proposed by {methodLabel(action.proposedBy, info?.world)}. {delayText(action)}.
          </p>
        </div>
        {action.status === "stale" ? (
          <Badge tone="danger">Out of date</Badge>
        ) : action.status === "needs-approval" ? (
          <Badge tone="warning">{action.approvals.length} of 2 approvals</Badge>
        ) : canRun ? (
          <Badge tone="success">Ready</Badge>
        ) : action.executeAfter !== null ? (
          <Badge>
            <Clock aria-hidden="true" className="size-3" />
            <Countdown until={action.executeAfter} />
          </Badge>
        ) : null}
      </div>
      <DecodedLines decoded={action.decoded} />
      {action.decoded.warning ? <Notice tone="warning">{action.decoded.warning}</Notice> : null}
      {action.status === "stale" ? (
        <p className="text-sm text-muted-foreground">
          The account configuration changed, so this action cannot run. Cancel it to clear this row.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {action.status === "needs-approval" ? (
          <Button
            variant="secondary"
            onClick={() =>
              onApprove({
                action: { kind: "approve-recovery", actionId: action.id },
                choices: approveChoices,
                note: "A second device-bound method must approve. Check the new value first.",
              })
            }
          >
            Approve
          </Button>
        ) : action.status !== "stale" ? (
          <Button variant="secondary" disabled={!canRun || running} onClick={execute}>
            {running ? "Running…" : "Execute"}
          </Button>
        ) : null}
        <Button
          variant="danger"
          onClick={() =>
            onApprove({
              action: { kind: "cancel", actionId: action.id },
              only: action.cancelBy === "owner" ? account?.owner : undefined,
              note:
                action.cancelBy === "owner"
                  ? "Only the owner method can cancel a recovery."
                  : "Any enrolled method can cancel this action.",
            })
          }
        >
          Cancel action
        </Button>
      </div>
    {runError ? <Notice tone="danger" title="This action did not run">{runError}</Notice> : null}
    </li>
  );
}

export function PendingActions() {
  const { account, info, loading } = useWallet();
  const [lastRun, setLastRun] = useState<Hex | null>(null);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);

  if (!account) {
    return loading ? <Skeleton className="h-28 rounded-2xl" /> : null;
  }

  const open = ({ only, choices, ...rest }: OpenRequest) => {
    setSheetKey((key) => key + 1);
    if (choices) {
      setRequest({ ...rest, choices });
      return;
    }
    const single = account.methods.length === 1 ? account.methods[0].ref : undefined;
    const method = single && (!only || sameMethod(single, only)) ? single : undefined;
    setRequest({
      ...rest,
      choices: only ? requireMethod(account.methods, only, info?.world) : anyMethod(account.methods),
      method,
    });
  };

  return (
    <Card>
      <SectionTitle hint="Queued actions wait here. You can cancel them until they run.">
        Pending actions
      </SectionTitle>
      {account.pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {account.pending.map((action) => (
            <Row
              key={action.id}
              action={action}
              onApprove={open}
              onRan={setLastRun}
              approveChoices={recoveryChoices(account.methods, info?.world, action.approvals)}
            />
          ))}
        </ul>
      )}
      {lastRun ? (
        <Notice title="The action ran">
          <span className="font-mono text-xs break-all">{lastRun}</span> <CopyHex value={lastRun} />
        </Notice>
      ) : null}
      {request ? (
        <Sheet title="Approve" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </Card>
  );
}
