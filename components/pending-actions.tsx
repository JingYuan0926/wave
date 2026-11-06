"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import type { MethodRef, PendingAction } from "@/lib/api-types";
import { formatCountdown, formatDuration } from "@/lib/ui/format";
import { WORLD_ID, methodLabel, recoveryChoices, sameMethod } from "@/lib/ui/rules";
import { useNow } from "@/lib/ui/use-now";
import { ApproveFlow, DecodedLines, anyMethod, requireMethod, type ApprovalRequest } from "./approve-flow";
import { Badge, Button, Card, Notice, SectionTitle, Sheet, Skeleton } from "./ui";
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
  return action.appliedDelay < action.realDelay
    ? `Demo delay: ${applied} (real: ${real})`
    : `Delay: ${real}`;
}

type OpenRequest = Omit<ApprovalRequest, "choices"> & { only?: MethodRef; choices?: ApprovalRequest["choices"] };

function Row({
  action,
  onApprove,
  approveChoices,
}: {
  action: PendingAction;
  onApprove: (request: OpenRequest) => void;
  approveChoices: ApprovalRequest["choices"];
}) {
  const { info } = useWallet();
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
          <Button
            variant="secondary"
            disabled={!canRun}
            onClick={() =>
              onApprove({ action: { kind: "execute-scheduled", actionId: action.id } })
            }
          >
            Execute
          </Button>
        ) : null}
        <Button
          variant="danger"
          onClick={() =>
            onApprove({
              action: { kind: "cancel", actionId: action.id },
              only: action.cancelBy === "world" ? WORLD_ID : undefined,
              note:
                action.cancelBy === "world"
                  ? "Only World ID can cancel a recovery."
                  : "Any enrolled method can cancel this action.",
            })
          }
        >
          Cancel action
        </Button>
      </div>
    </li>
  );
}

export function PendingActions() {
  const { account, info, loading } = useWallet();
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
              approveChoices={recoveryChoices(account.methods, info?.world, action.approvals)}
            />
          ))}
        </ul>
      )}
      {request ? (
        <Sheet title="Approve" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </Card>
  );
}
