import type { ReactNode } from "react";
import { CircleCheck, ExternalLink, Fingerprint, Globe, KeyRound, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  WORLD_ID_SIMULATOR_URL,
  explainRejection,
  explorerTxUrl,
  findPasskey,
  methodLabel,
  nameFor,
  plainName,
  rankChoices,
  recoveryIdentityOf,
  shortHex,
  type Approval,
  type ApprovalStage,
  type Hex,
  type MethodChoice,
  type MethodRef,
  type Rejection,
  type TxPrepared,
} from "../lib/wave";
import { useStore } from "../store";
import { METHOD_ICON, PrimaryButton, focusRing } from "./ui";
import { WorldScan } from "./WorldScan";

const TX_NOT_SENT = "Nothing reached the chain.";

function Pulse({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="relative grid size-28 place-items-center">
      <span className="absolute inset-0 animate-ping rounded-full bg-wave/40 motion-reduce:hidden" aria-hidden />
      <span className="absolute inset-2 rounded-full bg-wave-soft" aria-hidden />
      <Icon className="relative size-12 text-wave-deep" strokeWidth={1.6} aria-hidden />
    </div>
  );
}

/** The hash of a real transaction, with its explorer link. */
export function TxLink({ hash, label = "Transaction" }: { hash: Hex; label?: string }) {
  const { info } = useStore().state;
  return (
    <p className="mt-3 text-sm leading-snug text-ink-2">
      {label}: <span className="font-mono">{shortHex(hash, 10, 8)}</span>{" "}
      {info && (
        <a
          href={explorerTxUrl(info, hash)}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 rounded font-semibold underline underline-offset-2 ${focusRing}`}
        >
          Open in explorer
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
    </p>
  );
}

/** One button for each method that may approve this. The method rank sets the order. */
export function ApproveButtons({ choices, onPick }: { choices: MethodChoice[]; onPick: (method: MethodRef) => void }) {
  const { info, local, localWallet } = useStore().state;
  const allowed = choices.filter((choice) => choice.allowed);
  return (
    <>
      {rankChoices(allowed, localWallet, local, info).map(({ view }, index) => {
        const name = plainName(view, localWallet, local, info?.world);
        const Icon = view.ref.kind === "world" ? METHOD_ICON.worldid : name === "Security key" ? KeyRound : METHOD_ICON.faceid;
        return (
          <PrimaryButton key={view.validator} tone={index === 0 ? "deep" : "ghost"} onClick={() => onPick(view.ref)}>
            <Icon className="size-5" aria-hidden /> Approve with {name}
          </PrimaryButton>
        );
      })}
    </>
  );
}

/** The lines that the server decoded from an action. */
export function DecodedLines({ lines }: { lines: TxPrepared["decoded"]["lines"] }) {
  if (lines.length === 0) return null;
  return (
    <dl className="mt-3 divide-y divide-line rounded-[24px] bg-surface px-4">
      {lines.map((line) => (
        <div key={line.label} className="flex justify-between gap-4 py-3">
          <dt className="shrink-0 text-[15px] text-muted">{line.label}</dt>
          <dd className={`min-w-0 text-right text-[15px] font-semibold ${line.mono ? "break-all font-mono text-sm" : ""}`}>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the server decoded from the built calls. The owner reads this before signing. */
function Decoded({ prepared }: { prepared: TxPrepared }) {
  const { decoded } = prepared;
  return (
    <div className="w-full text-left">
      <p className="text-center text-[17px] font-bold">{decoded.title}</p>
      <DecodedLines lines={decoded.lines} />
      {decoded.warning && <p className="mt-3 rounded-[20px] bg-warn-soft p-4 text-sm leading-snug text-ink-2">{decoded.warning}</p>}
      {prepared.deploys && <p className="mt-3 text-center text-sm text-muted">This transaction also deploys your wallet.</p>}
      {prepared.sponsored && <p className="mt-1 text-center text-sm text-muted">This transaction costs your wallet no ETH.</p>}
    </div>
  );
}

function SignStep({
  approval,
  prepared,
  rootChanged,
  direct,
}: {
  approval: Approval;
  prepared: TxPrepared;
  rootChanged: boolean;
  /** The screen before this one already showed the details and the Approve press. */
  direct?: boolean;
}) {
  const { info, account, local, localWallet } = useStore().state;
  if (!info || !account) return null;
  const { method } = prepared;

  if (method.kind === "world") {
    const name = methodLabel(method, info.world);
    const simulator = info.world.mode === "idkit" && info.world.environment !== "production";
    return (
      <div className="flex w-full flex-col items-center">
        {!direct && <Decoded prepared={prepared} />}
        {rootChanged && <p className="mt-3 text-sm font-semibold text-ink">World's root changed. Scan again.</p>}
        {!direct && info.world.mode === "dev" && (
          <p className="mt-3 max-w-[18rem] text-center text-sm leading-relaxed text-muted">{name} signs this exact transaction.</p>
        )}
        <div className="mt-4 w-full">
          <WorldScan
            world={info.world}
            signal={prepared.sigHash}
            label={rootChanged ? "Scan again" : `Approve with ${name}`}
            autoStart={direct && !rootChanged}
            identity={recoveryIdentityOf(account.ownerNullifierHash)}
            onProof={(proof) => approval.submitWorldProof(proof)}
          />
        </div>
        {simulator && !direct && (
          <a
            href={WORLD_ID_SIMULATOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-surface px-5 text-[15px] font-semibold hover:bg-surface-2 ${focusRing}`}
          >
            Open World ID Simulator
            <ExternalLink className="size-4" aria-hidden />
          </a>
        )}
      </div>
    );
  }

  const held = method.kind === "passkey" && localWallet && local ? findPasskey(local, localWallet.address, method.slot) : null;
  const isKey = held?.name === "security-key";
  const Icon = isKey ? KeyRound : Fingerprint;
  return (
    <div className="flex w-full flex-col items-center">
      <Decoded prepared={prepared} />
      <div className="mt-4 w-full">
        <PrimaryButton onClick={() => void approval.signPasskey()}>
          <Icon className="size-5" aria-hidden />
          {isKey ? "Approve with security key" : `Approve with ${nameFor(method, held, info.world)}`}
        </PrimaryButton>
      </div>
      <p className="mt-2 text-center text-sm text-muted">
        {isKey ? "The chain checks the signature from your key." : "Face ID and Touch ID only unlock the passkey. The chain checks the signature."}
      </p>
    </div>
  );
}

/** The earth for World ID, and the fingerprint for a device method. */
const stageIcon = (prepared: TxPrepared): LucideIcon => (prepared.method.kind === "world" ? Globe : Fingerprint);

function Waiting({ icon, title, body, hash }: { icon: LucideIcon; title: string; body: string; hash?: Hex }) {
  return (
    <div className="flex flex-col items-center py-6 text-center" role="status" aria-live="polite">
      <Pulse icon={icon} />
      <p className="mt-6 text-xl font-bold">{title}</p>
      <p className="mt-2 max-w-[17rem] text-[15px] leading-relaxed text-muted">{body}</p>
      {hash && <TxLink hash={hash} />}
    </div>
  );
}

function Refused({
  title,
  body,
  children,
  onRetry,
  retryLabel,
}: {
  title: string;
  body: string;
  children?: ReactNode;
  onRetry?: () => void;
  retryLabel: string;
}) {
  return (
    <div className="flex flex-col items-center pt-4 text-center" role="alert">
      <span className="grid size-24 animate-pop-in place-items-center rounded-full bg-danger-soft">
        <TriangleAlert className="size-12 text-danger" strokeWidth={1.8} aria-hidden />
      </span>
      <p className="mt-6 text-2xl font-bold tracking-tight">{title}</p>
      <p className="mt-2 max-w-[18rem] text-[15px] leading-relaxed text-muted">{body}</p>
      {children}
      {onRetry && (
        <div className="mt-6 w-full">
          <PrimaryButton tone="ghost" onClick={onRetry}>
            {retryLabel}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

function RejectedStep({ rejection, onRetry }: { rejection: Rejection; onRetry: () => void }) {
  const text = explainRejection(rejection);
  return (
    <Refused title={text.title} body={text.detail} onRetry={onRetry} retryLabel="Choose another method">
      <p className="mt-2 max-w-[18rem] text-sm leading-relaxed text-muted">{text.stage}</p>
      <p className="mt-2 font-mono text-xs text-muted">
        {rejection.code}
        {rejection.failedFrameIndex !== undefined ? ` at frame ${rejection.failedFrameIndex}` : ""}
      </p>
      {rejection.txHash ? <TxLink hash={rejection.txHash} /> : <p className="mt-3 text-sm text-ink-2">{TX_NOT_SENT}</p>}
    </Refused>
  );
}

function FailedStep({ stage, onRetry }: { stage: Extract<ApprovalStage, { name: "failed" }>; onRetry: () => void }) {
  return (
    <Refused
      title="This did not finish"
      body={stage.message}
      // A second try after an unknown send can pay twice. The owner must check Activity first.
      onRetry={stage.sent === "no" ? onRetry : undefined}
      retryLabel="Try again"
    >
      {stage.txHash ? (
        <TxLink hash={stage.txHash} />
      ) : (
        <p className="mt-3 max-w-[18rem] text-sm leading-snug text-ink-2">
          {stage.sent === "no" ? TX_NOT_SENT : "WAVE cannot tell if this reached the chain. Check Activity before you try again."}
        </p>
      )}
    </Refused>
  );
}

function outcomeTitle(stage: Extract<ApprovalStage, { name: "done" }>) {
  if (stage.outcome === "applied") return "Applied";
  if (stage.outcome === "queued") return "Queued";
  return stage.outcome === "unconfirmed" ? "Sent, no receipt yet" : "Sent";
}

function outcomeBody(stage: Extract<ApprovalStage, { name: "done" }>, queuedBody?: string) {
  if (stage.outcome === "queued" && !stage.runError) return queuedBody ?? "This has not run yet. It waits in Payments.";
  if (stage.outcome === "unconfirmed") return "The mempool holds this transaction. WAVE has no receipt yet, so check it in the explorer.";
  return stage.prepared.decoded.title;
}

/**
 * Shows the real state of an approval, from the first build to the final hash. A screen renders
 * this after it calls `approval.start`, and `onDone` closes the screen.
 */
export function ApprovingView({
  approval,
  onDone,
  doneTitle,
  queuedBody,
}: {
  approval: Approval;
  onDone: () => void;
  /** The title of a confirmed action. It does not apply to a transaction with no receipt. */
  doneTitle?: string;
  /** The text of an action that waits in the queue. Use it to name the real wait. */
  queuedBody?: string;
}) {
  const { stage } = approval;
  switch (stage.name) {
    case "idle":
      return null;
    case "preparing":
      return (
        <Waiting
          icon={stage.method.kind === "world" ? Globe : Fingerprint}
          title="Getting ready"
          body="Loading…"
        />
      );
    case "sign":
      return <SignStep approval={approval} prepared={stage.prepared} rootChanged={stage.rootChanged} direct={stage.direct} />;
    case "signing":
      return <Waiting icon={Fingerprint} title="Confirm on your device" body="Your device signs this exact transaction." />;
    case "sending":
      return <Waiting icon={stageIcon(stage.prepared)} title="Sending" body="Loading…" />;
    case "mining":
      return <Waiting icon={stageIcon(stage.prepared)} title="Sending" body="Loading…" hash={stage.txHash} />;
    case "running":
      return (
        <Waiting
          icon={stageIcon(stage.prepared)}
          title="Applying the change"
          body="Loading…"
          hash={stage.txHash}
        />
      );
    case "rejected":
      return <RejectedStep rejection={stage.rejection} onRetry={approval.reset} />;
    case "failed":
      return <FailedStep stage={stage} onRetry={approval.reset} />;
    case "done":
      return (
        <DoneView title={stage.outcome === "sent" && doneTitle ? doneTitle : outcomeTitle(stage)} body={outcomeBody(stage, queuedBody)} onDone={onDone}>
          {stage.runError && (
            <p className="mt-3 max-w-[18rem] text-sm font-semibold leading-snug text-danger">
              You approved this, but it did not run. Run it from Payments. {stage.runError}
            </p>
          )}
          {stage.ranHash && <TxLink hash={stage.ranHash} label="Applied in" />}
          <TxLink hash={stage.txHash} label={stage.ranHash ? "Your approval" : "Transaction"} />
        </DoneView>
      );
  }
}

/** A control that a later stage connects. It says so, and it shows no success. */
export function NotConnectedView({ what, onDone }: { what: string; onDone: () => void }) {
  return <Refused title="Not connected yet" body={`${what} is not connected yet. ${TX_NOT_SENT}`} onRetry={onDone} retryLabel="Close" />;
}

export function DoneView({
  title,
  body,
  onDone,
  children,
}: {
  title: string;
  body: string;
  onDone: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center pt-4 text-center" role="status" aria-live="polite">
      <span className="grid size-24 animate-pop-in place-items-center rounded-full bg-wave">
        <CircleCheck className="size-12 text-ink" strokeWidth={1.8} aria-hidden />
      </span>
      <p className="mt-6 text-2xl font-bold tracking-tight">{title}</p>
      <p className="mt-2 max-w-[18rem] text-[15px] leading-relaxed text-muted">{body}</p>
      {children}
      <div className="mt-8 w-full">
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
      </div>
    </div>
  );
}
