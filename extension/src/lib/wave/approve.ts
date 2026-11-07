import { useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type {
  AccountResponse,
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
import { getPasskey, setRootHint, type LocalState, type LocalWallet } from "@/lib/ui/local";
import { signWithPasskey } from "@/lib/ui/passkey";
import { sameMethod, type MethodChoice } from "@/lib/ui/rules";
import { methodLabel, plainName } from "./names";
import { sameRoot } from "@/lib/ui/world";
import { errorText, passkeyErrorText } from "./map";

/**
 * The same steps as components/approve-flow.tsx, with no UI: prepare, sign, send, wait for the
 * chain, run a no-wait action. A screen shows the stage and calls the functions of `Approval`.
 * A real path never ends in "done" unless the server returned a transaction hash.
 */

export const WORLD_ID_SIMULATOR_URL = "https://simulator.worldcoin.org";

const POLL_MS = 2000;
const POLL_TRIES = 45;
/** A build older than this can hold a stale nonce, so WAVE builds again. */
const BUILT_MAX_AGE_MS = 60_000;

export type ApprovalContext = {
  wallet: LocalWallet;
  account: AccountResponse;
  refresh: () => Promise<void>;
  /** Runs after the mempool accepts the transaction. It also runs if the sheet closed before that. */
  onAccepted?: () => void | Promise<void>;
};

export type ApprovalOutcome =
  /** The chain included the transaction. */
  | "sent"
  /** The action waits in the queue. It has not run yet. */
  | "queued"
  /** The approval also ran the action. */
  | "applied"
  /** The mempool holds the transaction, and WAVE has no receipt yet. */
  | "unconfirmed";

export type ApprovalStage =
  | { name: "idle" }
  | { name: "preparing"; method: MethodRef }
  /**
   * The server built the transaction. The owner reads it, then signs or scans. With `direct`, the
   * screen already showed the details, so this step does not show them again.
   */
  | { name: "sign"; prepared: TxPrepared; rootChanged: boolean; direct?: boolean }
  | { name: "signing"; prepared: TxPrepared }
  | { name: "sending"; prepared: TxPrepared }
  | { name: "mining"; prepared: TxPrepared; txHash: Hex }
  | { name: "running"; prepared: TxPrepared; txHash: Hex }
  | { name: "rejected"; rejection: Rejection }
  /** `txHash` is set when the transaction reached the mempool. `sent` is "unknown" if WAVE cannot tell. */
  | { name: "failed"; message: string; sent: "no" | "unknown" | "yes"; txHash?: Hex }
  | {
      name: "done";
      outcome: ApprovalOutcome;
      prepared: TxPrepared;
      txHash: Hex;
      frames: FrameView[];
      /** The transaction that ran the action, on a wallet with no wait. */
      ranHash?: Hex;
      /** The owner approved, but the server could not run the action. */
      runError?: string;
    };

export type Approval = {
  stage: ApprovalStage;
  /** Builds the transaction for this method. The server decodes what the owner will read. */
  start: (method: MethodRef) => Promise<void>;
  /** Builds in the background while the owner reads the details. The stage does not change. */
  prebuild: (method: MethodRef) => Promise<void>;
  /** The Approve press on a screen that showed the details. It goes straight to the device or the scan. */
  approveNow: (method: MethodRef) => Promise<void>;
  /** Signs sig_hash with the passkey of the prepared method. Call this from a click. */
  signPasskey: () => Promise<void>;
  /** Takes the World ID proof for the prepared transaction. */
  submitWorldProof: (proof: WorldProof) => Promise<void>;
  /** Back to the start, so the owner can pick another method. */
  reset: () => void;
};

type Latest = { action: TxAction | null; context: ApprovalContext | null };

function createApproval(latest: { current: Latest }, read: () => ApprovalStage, write: (stage: ApprovalStage) => void) {
  const fail = (cause: unknown, fallback: string, sent: "no" | "unknown" = "no") =>
    write({ name: "failed", message: errorText(cause, fallback), sent });

  const buildRequest = (method: MethodRef, rootHint?: Hex) => {
    const { action, context } = latest.current;
    if (!action || !context) return null;
    const { wallet, account } = context;
    return {
      account: wallet.address,
      deployment: account.deployed ? undefined : wallet.plan,
      action,
      method,
      rootHint: rootHint ?? wallet.rootHint ?? undefined,
    };
  };

  /** A warning from the server must show, so that action keeps its own read step. */
  const signStage = (prepared: TxPrepared, rootChanged: boolean, direct: boolean): ApprovalStage => ({
    name: "sign",
    prepared,
    rootChanged,
    direct: direct && !prepared.decoded.warning,
  });

  const prepare = async (method: MethodRef, rootHint?: Hex, rootChanged = false, direct = false) => {
    const request = buildRequest(method, rootHint);
    if (!request) {
      write({ name: "failed", message: "The wallet has not loaded yet.", sent: "no" });
      return;
    }
    write({ name: "preparing", method });
    try {
      const prepared = await api.txPrepare(request);
      if (prepared.ok) write(signStage(prepared, rootChanged, direct));
      else write({ name: "rejected", rejection: prepared.rejection });
    } catch (cause) {
      fail(cause, "WAVE could not build the transaction.");
    }
  };

  /** Waits for a hash that has no receipt yet. Null means that the wait ran out. */
  const waitForChain = async (txHash: Hex) => {
    for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      // A failed read says nothing about the transaction, so the loop reads again.
      const status = await api.txStatus(txHash).catch(() => null);
      if (status && status.state !== "queued") return status;
    }
    return null;
  };

  const send = async (prepared: TxPrepared, witness: TxWitness) => {
    const context = latest.current.context;
    write({ name: "sending", prepared });
    let sent;
    try {
      sent = await api.txSend({ envelope: prepared.envelope, method: prepared.method, witness });
    } catch (cause) {
      // The request can fail after the server sent the transaction, so a retry can pay twice.
      fail(cause, "WAVE could not send the transaction.", "unknown");
      return;
    }
    if (!sent.ok) {
      write({ name: "rejected", rejection: sent.rejection });
      return;
    }

    const { txHash, scheduledId } = sent;
    let frames = sent.frames;
    // Frames have a status only after the transaction is mined.
    let confirmed = frames.some((frame) => frame.status);
    if (!confirmed) {
      write({ name: "mining", prepared, txHash });
      const status = await waitForChain(txHash);
      if (status?.state === "failed" && status.rejection) {
        write({ name: "rejected", rejection: status.rejection });
        return;
      }
      if (status?.state === "failed" || status?.state === "dropped") {
        write({ name: "failed", message: "The transaction did not run.", sent: "yes", txHash });
        return;
      }
      confirmed = status !== null;
      if (status) frames = status.frames;
    }

    const queued = confirmed && prepared.route === "schedule";
    const outcome: ApprovalOutcome = !confirmed ? "unconfirmed" : queued ? "queued" : "sent";
    const done = { name: "done", outcome, prepared, txHash, frames } as const;
    // A wallet with no wait shows no queue step: this one approval also runs the action.
    const actionId = prepared.runAtOnce ? (prepared.runActionId ?? scheduledId) : undefined;
    if (actionId && confirmed && context) {
      write({ name: "running", prepared, txHash });
      try {
        const { txHash: ranHash } = await api.runScheduled({ account: context.wallet.address, actionId });
        write({ ...done, outcome: "applied", ranHash });
      } catch (cause) {
        write({ ...done, runError: errorText(cause, "WAVE could not run this action.") });
      }
    } else if (prepared.runAtOnce && queued) {
      // The receipt read failed, so WAVE has no action ID. The action waits in Pending actions.
      write({ ...done, runError: "WAVE could not read the action from the receipt." });
    } else {
      write(done);
    }
    await context?.refresh().catch(() => undefined);
    await context?.onAccepted?.();
  };

  const signPasskey = async () => {
    const stage = read();
    if (stage.name !== "sign" || stage.prepared.method.kind !== "passkey") return;
    const { prepared } = stage;
    const { slot } = stage.prepared.method;
    const context = latest.current.context;
    write({ name: "signing", prepared });
    let data: Hex;
    try {
      // A browser can lose the stored ID. With no ID, the device shows its picker.
      const passkey = context ? getPasskey(context.wallet.address, slot) : null;
      data = await signWithPasskey(prepared.sigHash, passkey?.credentialId);
    } catch (cause) {
      write({ name: "failed", message: passkeyErrorText(cause, "The passkey did not sign."), sent: "no" });
      return;
    }
    await send(prepared, { kind: "passkey", slot, data });
  };

  const submitWorldProof = async (proof: WorldProof) => {
    const stage = read();
    if (stage.name !== "sign" || stage.prepared.method.kind !== "world") return;
    const { prepared } = stage;
    // The scan is over, so the screen leaves the scan step at once. A root publish can take seconds.
    write({ name: "sending", prepared });
    setRootHint(proof.merkleRoot);
    // The proof must use the referenced root. A new root changes sig_hash, so the proof cannot be
    // reused: publish the root, rebuild, and scan again.
    const referenced = prepared.rootReference?.root;
    if (referenced && !sameRoot(referenced, proof.merkleRoot)) {
      try {
        await api.rootPublish(proof.merkleRoot);
      } catch (cause) {
        fail(cause, "WAVE could not publish the World ID root.");
        return;
      }
      await prepare(prepared.method, proof.merkleRoot, true, stage.direct);
      return;
    }
    await send(prepared, {
      kind: "world",
      root: proof.merkleRoot,
      nullifierHash: proof.nullifierHash,
      proof: proof.proof,
    });
  };

  let built: { key: string; at: number; prepared: TxPrepared } | null = null;
  let building: Promise<void> | null = null;
  const keyOf = (method: MethodRef) => JSON.stringify([method, latest.current.action]);

  const prebuild = async (method: MethodRef) => {
    const request = buildRequest(method);
    if (!request) return;
    const key = keyOf(method);
    built = null;
    const job = api
      .txPrepare(request)
      .then((prepared) => {
        if (prepared.ok) built = { key, at: Date.now(), prepared };
      })
      // The Approve press builds again, and it shows any real failure.
      .catch(() => undefined);
    building = job;
    await job;
  };

  const approveNow = async (method: MethodRef) => {
    if (building) await building;
    const ready = built?.key === keyOf(method) && Date.now() - built.at < BUILT_MAX_AGE_MS ? built.prepared : null;
    built = null;
    if (ready) write(signStage(ready, false, true));
    else await prepare(method, undefined, false, true);
    const stage = read();
    if (stage.name === "sign" && stage.direct && stage.prepared.method.kind === "passkey") await signPasskey();
  };

  return {
    start: (method: MethodRef) => prepare(method),
    prebuild,
    approveNow,
    signPasskey,
    submitWorldProof,
    reset: () => write({ name: "idle" }),
  };
}

/** The approval of one action. `action` and `context` can change between renders. */
export function useApproval(action: TxAction | null, context: ApprovalContext | null): Approval {
  const [stage, setStage] = useState<ApprovalStage>({ name: "idle" });
  const latest = useRef<Latest>({ action, context });
  latest.current = { action, context };
  const current = useRef(stage);
  const steps = useMemo(
    () =>
      createApproval(
        latest,
        () => current.current,
        (next) => {
          current.current = next;
          setStage(next);
        },
      ),
    [],
  );
  return { stage, ...steps };
}

/* ---------- Who can approve ---------- */

export function anyMethod(methods: MethodView[]): MethodChoice[] {
  return methods.map((view) => ({ view, allowed: true }));
}

export function requireMethod(methods: MethodView[], ref: MethodRef, world?: InfoResponse["world"]): MethodChoice[] {
  return methods.map((view) => ({
    view,
    allowed: sameMethod(view.ref, ref),
    reason: sameMethod(view.ref, ref) ? undefined : `This action needs ${methodLabel(ref, world)}.`,
  }));
}

/** The method rank: World ID, security key, passkey. Allowed methods come first. */
export function rankChoices(
  choices: MethodChoice[],
  wallet: LocalWallet | null,
  local: LocalState | null,
  info: InfoResponse | null,
): MethodChoice[] {
  const rank = ({ view, allowed }: MethodChoice) => {
    const kind = view.ref.kind === "world" ? 0 : plainName(view, wallet, local, info?.world) === "Security key" ? 1 : 2;
    return (allowed ? 0 : 10) + kind;
  };
  return [...choices].sort((a, b) => rank(a) - rank(b));
}
