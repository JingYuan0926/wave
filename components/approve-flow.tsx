"use client";

import { CheckCircle2, ExternalLink, Fingerprint, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, explorerTxUrl } from "@/lib/api-client";
import { CREATE_SIGNAL } from "@/lib/api-types";
import type {
  DecodedAction,
  DevIdentity,
  FrameView,
  Hex,
  InfoResponse,
  MethodRef,
  MethodView,
  Rejection,
  TxAction,
  TxPrepared,
  TxWitness,
  WorldProof,
} from "@/lib/api-types";
import { cn } from "@/lib/ui/cn";
import { findPasskey, getPasskey, recoveryIdentityOf, setRootHint } from "@/lib/ui/local";
import { signWithPasskey } from "@/lib/ui/passkey";
import { explainRejection } from "@/lib/ui/rejections";
import { methodDetail, methodLabel, nameFor, sameMethod, type MethodChoice } from "@/lib/ui/rules";
import { sameRoot } from "@/lib/ui/world";
import { Badge, Button, CopyHex, Notice, Skeleton, focusRing } from "./ui";
import { useWallet } from "./wallet-provider";
import { WorldScan } from "./world-scan";

export const ROOT_CHANGED_TEXT = "World's root changed. Scan again.";

export type ApprovalRequest = {
  action: TxAction;
  /** Who may approve. The owner can still pick a disallowed method. */
  choices: MethodChoice[];
  /** Set to skip the picker. */
  method?: MethodRef;
  /** The security demos expect a rejection. */
  expectRejection?: boolean;
  /** The rejection codes that prove the demo. Another code means that the demo tested nothing. */
  expectCodes?: string[];
  /** The security demo uses another test identity. */
  identity?: DevIdentity;
  /** The explanation for this action, above the picker. */
  note?: string;
};

type Stage =
  | { name: "pick" }
  | { name: "preparing" }
  | { name: "review"; prepared: TxPrepared; rootChanged: boolean }
  | { name: "sending"; prepared: TxPrepared }
  | { name: "rejected"; rejection: Rejection; prepared: TxPrepared | null }
  | { name: "failed"; message: string }
  | { name: "running"; prepared: TxPrepared }
  | {
      name: "done";
      prepared: TxPrepared;
      txHash: Hex;
      frames: FrameView[];
      /** The transaction that ran the action, on a wallet with no wait. */
      ranHash?: Hex;
      /** The owner approved, but the server could not run the action. */
      runError?: string;
    };

export function MethodPicker({
  choices,
  onPick,
}: {
  choices: MethodChoice[];
  onPick: (ref: MethodRef) => void;
}) {
  const { info, wallet, local } = useWallet();
  return (
    <ul className="flex flex-col gap-2">
      {choices.map(({ view, allowed, reason }) => {
        const held =
          view.ref.kind === "passkey" && wallet && local ? findPasskey(local, wallet.address, view.ref.slot) : null;
        // A browser can lose the stored ID, for example after Start over. The device still holds
        // the passkey, so the device picker finds it. The contract rejects a wrong passkey.
        const noStoredId = view.ref.kind === "passkey" && wallet !== null && local !== null && held === null;
        return (
          <li key={view.validator}>
            <button
              type="button"
              onClick={() => onPick(view.ref)}
              className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-start text-sm hover:bg-muted ${focusRing}`}
            >
              <span className="min-w-0">
                <span className="block font-medium">
                  {methodDetail(view, info?.world, nameFor(view.ref, held, info?.world))}
                </span>
                {reason ? <span className="block text-muted-foreground">{reason}</span> : null}
                {noStoredId && allowed ? (
                  <span className="block text-muted-foreground">
                    Your device will ask you to pick this passkey.
                  </span>
                ) : null}
              </span>
              <Badge tone={allowed ? "success" : "warning"} className="shrink-0">
                {allowed ? "Can approve" : "Will be rejected"}
              </Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FrameList({ frames, failedIndex }: { frames: FrameView[]; failedIndex?: number }) {
  if (frames.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">Frames</h3>
      <ol className="flex flex-col gap-1">
        {frames.map((frame) => {
          const failed = frame.status === "failed" || frame.index === failedIndex;
          return (
            <li key={frame.index} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {frame.index} {frame.mode}
                </span>{" "}
                {frame.label}
              </span>
              {frame.status ? (
                <Badge tone={failed ? "danger" : frame.status === "ok" ? "success" : "neutral"}>
                  {frame.status === "ok" ? "OK" : frame.status === "failed" ? "Failed" : "Skipped"}
                </Badge>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The decoded facts of an action: recipient, amount, new owner, delay. */
export function DecodedLines({ decoded }: { decoded: DecodedAction }) {
  if (decoded.lines.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1 rounded-xl bg-muted p-3 text-sm">
      {decoded.lines.map((line) => (
        // A long value moves to its own line, so a word or an address does not split.
        <div key={line.label} className="flex flex-wrap justify-between gap-x-4">
          <dt className="shrink-0 text-muted-foreground">{line.label}</dt>
          <dd
            className={cn(
              "min-w-0 text-end",
              line.mono ? "font-mono text-xs break-all tabular-nums" : "break-words",
            )}
          >
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Review({ prepared, world }: { prepared: TxPrepared; world: InfoResponse["world"] }) {
  const { decoded } = prepared;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-base font-semibold">{decoded.title}</p>
        <p className="text-sm text-muted-foreground">
          Approve with {methodLabel(prepared.method, world)}. Check this before you approve.
        </p>
      </div>
      <DecodedLines decoded={decoded} />
      {decoded.warning ? <Notice tone="warning">{decoded.warning}</Notice> : null}
      {prepared.deploys ? <Notice>This transaction also deploys your wallet.</Notice> : null}
      {prepared.sponsored ? <Notice title="Gas sponsored">This transaction costs your wallet no ETH.</Notice> : null}
      <FrameList frames={prepared.frames} />
    </div>
  );
}

function ExplorerLink({ info, hash, label = "Transaction hash" }: { info: InfoResponse; hash: Hex; label?: string }) {
  return (
    <div className="rounded-xl bg-muted px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-xs break-all">{hash}</p>
      <div className="flex items-center gap-3">
        <CopyHex value={hash} />
        <a
          href={explorerTxUrl(info, hash)}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex min-h-10 items-center gap-1 rounded-lg text-sm underline ${focusRing}`}
        >
          Open in explorer
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      </div>
    </div>
  );
}

function RejectionView({
  info,
  rejection,
  expected,
  missed,
  onRetry,
}: {
  info: InfoResponse;
  rejection: Rejection;
  expected: boolean;
  /** A security demo stopped for another reason, so it proves nothing. */
  missed: boolean;
  onRetry?: () => void;
}) {
  const text = explainRejection(rejection);
  const Icon = expected ? CheckCircle2 : XCircle;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden="true"
          className={cn("mt-0.5 size-5 shrink-0", expected ? "text-success" : "text-destructive")}
        />
        <div>
          <p className="font-semibold">{expected ? "Rejected, as it should be" : text.title}</p>
          <p className="text-sm text-muted-foreground">
            {expected ? `${text.title}. ` : ""}
            {text.detail}
          </p>
          <p className="text-sm text-muted-foreground">{text.stage}</p>
        </div>
      </div>
      {missed ? (
        <Notice tone="warning" title="This test did not reach its check">
          The transaction stopped for another reason, so this result proves nothing.
        </Notice>
      ) : null}
      <p className="font-mono text-xs text-muted-foreground">
        {rejection.code}
        {rejection.failedFrameIndex !== undefined ? ` at frame ${rejection.failedFrameIndex}` : ""}
        {rejection.haltReason ? ` (${rejection.haltReason})` : ""}
      </p>
      {rejection.txHash ? (
        <ExplorerLink info={info} hash={rejection.txHash} />
      ) : (
        <p className="text-sm text-muted-foreground">
          WAVE sent nothing to the chain, so this has no transaction hash.
        </p>
      )}
      {rejection.frames ? (
        <FrameList frames={rejection.frames} failedIndex={rejection.failedFrameIndex} />
      ) : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Choose another method
        </Button>
      ) : null}
    </div>
  );
}

function PasskeyApprove({ prepared, onApprove }: { prepared: TxPrepared; onApprove: () => void }) {
  const { method } = prepared;
  const { wallet, local } = useWallet();
  const held = method.kind === "passkey" && wallet && local ? findPasskey(local, wallet.address, method.slot) : null;
  const isKey = held?.name === "security-key";
  return (
    <div className="flex flex-col gap-2">
      <Button onClick={onApprove}>
        <Fingerprint aria-hidden="true" className="size-4" />
        {isKey ? "Approve with security key" : "Approve with Face ID / Touch ID"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {isKey
          ? "The chain checks the signature from your key."
          : "Face ID and Touch ID only unlock the passkey. The chain checks the signature."}
      </p>
    </div>
  );
}

/** The one path for every transaction: pick, prepare, review, sign, send, result. */
export function ApproveFlow({
  request,
  onDone,
}: {
  request: ApprovalRequest;
  /** Called after an accepted transaction. */
  onDone?: () => void;
}) {
  const { wallet, account, info, refresh, local } = useWallet();
  const [stage, setStage] = useState<Stage>(() =>
    request.method ? { name: "preparing" } : { name: "pick" },
  );
  const started = useRef(false);

  const prepare = useCallback(
    async (method: MethodRef, rootHint?: Hex, rootChanged = false) => {
      if (!wallet || !account) return;
      setStage({ name: "preparing" });
      try {
        const prepared = await api.txPrepare({
          account: wallet.address,
          deployment: account.deployed
            ? undefined
            : wallet.plan,
          action: request.action,
          method,
          rootHint: rootHint ?? wallet.rootHint ?? undefined,
        });
        if (prepared.ok) {
          setStage({ name: "review", prepared, rootChanged });
        } else {
          setStage({ name: "rejected", rejection: prepared.rejection, prepared: null });
        }
      } catch (cause) {
        setStage({
          name: "failed",
          message: cause instanceof Error ? cause.message : "WAVE could not build the transaction.",
        });
      }
    },
    [wallet, account, request.action],
  );

  const fixedMethod = request.method;
  const demoIdentity = request.identity;

  useEffect(() => {
    if (!fixedMethod) return;
    // `prepare` changes with each poll. The ref stops a second build.
    const timer = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      void (async () => {
        try {
          // A demo identity has its own root. Read that root first, so that the demo
          // needs one scan and does not show "World's root changed".
          const root = demoIdentity
            ? (await api.worldDevProof(demoIdentity, CREATE_SIGNAL)).merkleRoot
            : undefined;
          await prepare(fixedMethod, root);
        } catch (cause) {
          setStage({
            name: "failed",
            message: cause instanceof Error ? cause.message : "The test identity failed.",
          });
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, [fixedMethod, demoIdentity, prepare]);

  const send = async (prepared: TxPrepared, witness: TxWitness) => {
    setStage({ name: "sending", prepared });
    try {
      const sent = await api.txSend({
        envelope: prepared.envelope,
        method: prepared.method,
        witness,
      });
      if (!sent.ok) {
        setStage({ name: "rejected", rejection: sent.rejection, prepared });
        return;
      }
      const done = { name: "done", prepared, txHash: sent.txHash, frames: sent.frames } as const;
      // A wallet with no wait shows no queue step: this one approval also runs the action.
      const actionId = prepared.runAtOnce ? (prepared.runActionId ?? sent.scheduledId) : undefined;
      if (actionId && wallet) {
        setStage({ name: "running", prepared });
        try {
          const { txHash: ranHash } = await api.runScheduled({ account: wallet.address, actionId });
          setStage({ ...done, ranHash });
        } catch (cause) {
          const runError = cause instanceof Error ? cause.message : "WAVE could not run this action.";
          setStage({ ...done, runError });
        }
      } else {
        setStage(done);
      }
      await refresh();
      onDone?.();
    } catch (cause) {
      setStage({
        name: "failed",
        message: cause instanceof Error ? cause.message : "WAVE could not send the transaction.",
      });
    }
  };

  const onWorldProof = async (prepared: TxPrepared, proof: WorldProof) => {
    const referenced = prepared.rootReference?.root;
    // A demo identity is not the owner, so its root must not become the wallet's hint.
    if (!request.identity) setRootHint(proof.merkleRoot);
    // The proof must use the referenced root. A new root changes sig_hash, so
    // the proof cannot be reused: publish the root, rebuild, and scan again.
    if (referenced && !sameRoot(referenced, proof.merkleRoot)) {
      await api.rootPublish(proof.merkleRoot);
      await prepare(prepared.method, proof.merkleRoot, true);
      return;
    }
    await send(prepared, {
      kind: "world",
      root: proof.merkleRoot,
      nullifierHash: proof.nullifierHash,
      proof: proof.proof,
    });
  };

  const onPasskey = async (prepared: TxPrepared) => {
    const { method } = prepared;
    if (method.kind !== "passkey" || !wallet) return;
    const passkey = getPasskey(wallet.address, method.slot);
    try {
      const data = await signWithPasskey(prepared.sigHash, passkey?.credentialId);
      await send(prepared, { kind: "passkey", slot: method.slot, data });
    } catch (cause) {
      setStage({
        name: "failed",
        message: cause instanceof Error ? cause.message : "The passkey did not sign.",
      });
    }
  };

  if (!info || !wallet || !account || !local) return <Skeleton className="h-40" />;

  // A demo has no choices. A transfer keeps its choices, so a rejected method can be replaced.
  const backToPick = request.choices.length > 1 ? () => setStage({ name: "pick" }) : undefined;

  switch (stage.name) {
    case "pick":
      return (
        <div className="flex flex-col gap-3">
          {request.note ? <p className="text-sm text-muted-foreground">{request.note}</p> : null}
          <MethodPicker choices={request.choices} onPick={(ref) => void prepare(ref)} />
        </div>
      );
    case "preparing":
      return (
        <div className="flex flex-col gap-3" role="status" aria-label="Building the transaction">
          <p className="text-sm text-muted-foreground">
            Building the transaction.
            {account.methods.some((view) => view.ref.kind === "world")
              ? " The first World ID transaction publishes a root to the chain, so it can take about 20 seconds."
              : ""}
          </p>
          <Skeleton className="h-16" />
          <Skeleton className="h-24" />
        </div>
      );
    case "review": {
      const { prepared, rootChanged } = stage;
      return (
        <div className="flex flex-col gap-4">
          {rootChanged ? <Notice tone="warning" title={ROOT_CHANGED_TEXT} /> : null}
          <Review prepared={prepared} world={info.world} />
          {prepared.method.kind === "world" ? (
            <WorldScan
              world={info.world}
              signal={prepared.sigHash}
              label={rootChanged ? "Scan again" : "Scan with World ID"}
              identity={request.identity ?? recoveryIdentityOf(account.ownerNullifierHash)}
              onProof={(proof) => onWorldProof(prepared, proof)}
            />
          ) : (
            <PasskeyApprove prepared={prepared} onApprove={() => void onPasskey(prepared)} />
          )}
          {backToPick ? (
            <Button variant="ghost" onClick={backToPick}>
              Choose another method
            </Button>
          ) : null}
        </div>
      );
    }
    case "sending":
      return (
        <div className="flex flex-col gap-3" role="status">
          <p className="font-semibold">Sending</p>
          <p className="text-sm text-muted-foreground">
            WAVE simulates the transaction, then sends it to the mempool. The bundle runs every
            10 seconds.
          </p>
          <FrameList frames={stage.prepared.frames} />
        </div>
      );
    case "running":
      return (
        <div className="flex flex-col gap-3" role="status">
          <p className="font-semibold">Applying the change</p>
          <p className="text-sm text-muted-foreground">
            This wallet has no wait, so the change runs now. You do not need to approve again.
          </p>
        </div>
      );
    case "rejected": {
      const demo = request.expectRejection ?? false;
      const proved = demo && (request.expectCodes ?? []).includes(stage.rejection.code);
      return (
        <RejectionView
          info={info}
          rejection={stage.rejection}
          expected={proved}
          missed={demo && !proved}
          onRetry={backToPick}
        />
      );
    }
    case "failed":
      return (
        <Notice
          tone="danger"
          title="This did not finish"
          action={
            backToPick ? (
              <Button variant="secondary" onClick={backToPick}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {stage.message}
        </Notice>
      );
    case "done": {
      // Frames have a status only after the tx is mined.
      const applied = stage.ranHash !== undefined;
      const queued =
        !applied && stage.prepared.route === "schedule" && stage.frames.some((f) => f.status);
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
            <div className="min-w-0">
              <p className="font-semibold">
                {request.expectRejection
                  ? "The chain accepted this. It should not."
                  : applied
                    ? "Applied"
                    : queued
                      ? "Queued"
                      : "Sent"}
              </p>
              <p className="text-sm text-muted-foreground">{stage.prepared.decoded.title}</p>
              {queued ? (
                <p className="text-sm text-muted-foreground">
                  This has not run yet. It waits in Pending actions on the Wallet page.
                </p>
              ) : null}
            </div>
          </div>
          {stage.runError ? (
            <Notice tone="warning" title="You approved this, but it did not run">
              Run it from Pending actions on the Wallet page. {stage.runError}
            </Notice>
          ) : null}
          {stage.ranHash ? <ExplorerLink info={info} hash={stage.ranHash} label="Transaction that applied it" /> : null}
          <ExplorerLink info={info} hash={stage.txHash} label={stage.ranHash ? "Your approval" : undefined} />
          <FrameList frames={stage.frames} />
        </div>
      );
    }
  }
}

export function requireMethod(
  methods: MethodView[],
  ref: MethodRef,
  world?: InfoResponse["world"],
): MethodChoice[] {
  return methods.map((view) => ({
    view,
    allowed: sameMethod(view.ref, ref),
    reason: sameMethod(view.ref, ref) ? undefined : `This action needs ${methodLabel(ref, world)}.`,
  }));
}

export function anyMethod(methods: MethodView[]): MethodChoice[] {
  return methods.map((view) => ({ view, allowed: true }));
}
