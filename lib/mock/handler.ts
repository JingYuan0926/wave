/**
 * A browser-only stand-in for app/api. It exists for UI development only.
 * lib/api-client.ts imports it only when NEXT_PUBLIC_WAVE_MOCK=1. A normal
 * build drops the import, so no chain data on any normal run comes from here.
 */
import { keccak256, pad, stringToHex } from "viem";
import { slotsOf } from "@/lib/account";
import { ApiError } from "@/lib/api-client";
import {
  API_ROUTES,
  ETH_TOKEN,
  type AccountResponse,
  type ActivityItem,
  type ActivityResponse,
  type Address,
  type DailyView,
  type DecodedAction,
  type FaucetResponse,
  type FrameView,
  type Hex,
  type InfoResponse,
  type MethodRef,
  type MethodView,
  type PasskeySlot,
  type WalletPlan,
  type WalletPlanResponse,
  type PendingAction,
  type Rejection,
  type RootPublishResponse,
  type Tier,
  type TokenInfo,
  type TxAction,
  type TxPrepareRequest,
  type TxPrepareResponse,
  type TxSendRequest,
  type TxSendResponse,
  type TxStatusResponse,
  type WorldDevProofRequest,
  type WorldDevProofResponse,
  type WorldVerifyRequest,
  type WorldVerifyResponse,
} from "@/lib/api-types";
import { formatAmount, plainAmount, shortHex } from "@/lib/ui/format";
import { describeSpend, maskHas, methodLabel, sameMethod } from "@/lib/ui/rules";

const USDC: Address = "0x00000000000000000000000000000000000f00d1";
const TOKENS: TokenInfo[] = [
  { address: ETH_TOKEN, symbol: "ETH", name: "Ether", decimals: 18, isTest: false },
  { address: USDC, symbol: "tUSDC", name: "Test USDC", decimals: 6, isTest: true },
];
const DEMO_DELAY = 120;
const SOURCE_ID = keccak256(stringToHex("mock-source"));
const LATENCY_MS = 350;
const KEY = "wave.mock.v2";

type StoredTx = {
  envelope: Hex;
  account: Address;
  action: TxAction;
  method: MethodRef;
  frames: FrameView[];
  decoded: DecodedAction;
  root: Hex | null;
  deploys: boolean;
};

type MockAccount = {
  address: Address;
  owner: Hex;
  deployed: boolean;
  balances: Record<string, string>;
  configVersion: number;
  methods: MethodView[];
  tiers: Record<string, (Tier & { spent: string })[]>;
  /** The hard daily total of each token. No entry means no limit. */
  daily: Record<string, { limit: string; spent: string; start: number }>;
  pending: PendingAction[];
  activity: ActivityItem[];
};

export type MockControls = {
  /** The info route reports the chain as offline. */
  offline: boolean;
  /** The next test identity proof uses a new root. */
  rootChangeNext: boolean;
};

type MockState = MockControls & {
  accounts: Record<string, MockAccount>;
  txs: Record<string, StoredTx>;
  scheduled: Record<string, TxAction>;
  root: Hex;
  counter: number;
};

function freshState(): MockState {
  return {
    offline: false,
    rootChangeNext: false,
    accounts: {},
    txs: {},
    scheduled: {},
    root: keccak256(stringToHex("mock-root-1")),
    counter: 0,
  };
}

let memory: MockState | null = null;

function load(): MockState {
  if (memory) return memory;
  try {
    const raw = window.localStorage.getItem(KEY);
    memory = raw ? { ...freshState(), ...(JSON.parse(raw) as MockState) } : freshState();
  } catch {
    memory = freshState();
  }
  return memory;
}

function save() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // The mock still works in memory.
  }
}

export function getMockControls(): MockControls {
  const { offline, rootChangeNext } = load();
  return { offline, rootChangeNext };
}

export function setMockControls(next: Partial<MockControls>) {
  Object.assign(load(), next);
  save();
}

export function resetMock() {
  memory = freshState();
  save();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function nextHash(state: MockState, label: string): Hex {
  state.counter += 1;
  return keccak256(stringToHex(`${label}-${state.counter}-${Date.now()}`));
}

function nullifierOf(trapdoor: Hex, nullifier: Hex): Hex {
  return keccak256(`${trapdoor}${nullifier.slice(2)}` as Hex);
}

function getAccount(state: MockState, address: string): MockAccount {
  const account = state.accounts[address.toLowerCase()];
  if (!account) {
    throw new ApiError("NOT_FOUND", `Mock account ${address} does not exist.`, 404);
  }
  return account;
}

function tokenOf(address: Address): TokenInfo {
  return TOKENS.find((t) => t.address === address) ?? TOKENS[0];
}

function refreshPending(account: MockAccount): PendingAction[] {
  const time = now();
  return account.pending.map((action) => {
    if (action.status === "waiting" && action.executeAfter !== null && action.executeAfter <= time) {
      return { ...action, status: "ready" };
    }
    return action;
  });
}

const MOCK_DAY = 86400;

/** The same result as WavePolicy.dailyOf, with a null when the token has no limit. */
function dailyView(account: MockAccount, token: string): DailyView | null {
  const daily = account.daily[token];
  if (!daily) return null;
  const open = daily.start > 0 && now() < daily.start + MOCK_DAY;
  const spent = open ? BigInt(daily.spent) : BigInt(0);
  const limit = BigInt(daily.limit);
  return {
    limit: daily.limit,
    spent: spent.toString(),
    left: (spent >= limit ? BigInt(0) : limit - spent).toString(),
    resetsAt: open && spent > BigInt(0) ? daily.start + MOCK_DAY : null,
  };
}

/** Writes a limit and keeps the window, as the account does. */
function setDaily(account: MockAccount, token: string, limit: string) {
  if (limit === "0") {
    delete account.daily[token];
    return;
  }
  const old = account.daily[token];
  account.daily[token] = { spent: old?.spent ?? "0", start: old?.start ?? 0, limit };
}

function countDaily(account: MockAccount, token: string, amount: bigint) {
  const daily = account.daily[token];
  if (!daily) return;
  if (dailyView(account, token)?.resetsAt == null) {
    daily.start = now();
    daily.spent = "0";
  }
  daily.spent = (BigInt(daily.spent) + amount).toString();
}

function accountView(account: MockAccount): AccountResponse {
  account.pending = refreshPending(account);
  const others = account.methods.filter((m) => !m.owner).length;
  return {
    address: account.address,
    deployed: account.deployed,
    balances: TOKENS.map((t) => ({ token: t.address, amount: account.balances[t.address] ?? "0" })),
    configVersion: String(account.configVersion),
    demoDelay: DEMO_DELAY,
    waitSeconds: DEMO_DELAY,
    ownerNullifierHash: null,
    owner: account.methods.find((m) => m.owner)?.ref ?? { kind: "world" },
    ownerKeyX: null,
    methods: account.methods,
    rules: TOKENS.map((t) => ({
      token: t.address,
      tiers: (account.tiers[t.address] ?? []).map((tier) => ({
        ...tier,
        periodEndsAt: tier.period > 0 ? now() + tier.period : null,
      })),
      daily: dailyView(account, t.address),
    })),
    pending: account.pending,
    recovery: { otherMethods: others, available: others >= 2 },
    sponsor: null,
  };
}

function decodeAction(account: MockAccount, action: TxAction): DecodedAction {
  switch (action.kind) {
    case "transfer": {
      const token = tokenOf(action.token);
      return {
        title: `Send ${plainAmount(action.amount, token.decimals)} ${token.symbol}`,
        lines: [
          { label: "To", value: action.to, mono: true },
          { label: "Amount", value: `${plainAmount(action.amount, token.decimals)} ${token.symbol}`, mono: true },
        ],
      };
    }
    case "install-passkey":
      return {
        title: `Add passkey in slot ${action.slot}`,
        lines: [
          { label: "Type", value: action.backupEligible ? "Synced passkey" : "Device-bound passkey" },
          { label: "Public key x", value: shortHex(action.publicKey.x), mono: true },
        ],
        warning: "This adds a new way to approve actions for this account.",
      };
    case "remove-passkey":
      return { title: `Remove passkey in slot ${action.slot}`, lines: [] };
    case "tighten":
      return {
        title: `Tighten ${tokenOf(action.token).symbol} rules`,
        lines: [{ label: "Tiers", value: String(action.tiers.length) }],
      };
    case "set-rules":
      return {
        title: `Change ${tokenOf(action.token).symbol} rules`,
        lines: [{ label: "Tiers", value: String(action.tiers.length) }],
        warning: "This change makes the rules looser.",
      };
    case "cancel":
      return { title: "Cancel a queued action", lines: [{ label: "Action", value: shortHex(action.actionId), mono: true }] };
    case "execute-scheduled":
      return { title: "Run a queued action", lines: [{ label: "Action", value: shortHex(action.actionId), mono: true }] };
    case "approve-recovery":
      return { title: "Approve recovery", lines: [{ label: "Action", value: shortHex(action.actionId), mono: true }] };
    case "propose-recovery":
      return {
        title: "Recovery: Change the wallet owner",
        lines: [
          {
            label: action.change.kind === "owner" ? "New owner" : "New source",
            value:
              action.change.kind === "owner"
                ? action.change.nullifierHash
                : action.change.kind === "root-source"
                  ? action.change.sourceId
                  : action.change.publicKey.x,
            mono: true,
          },
        ],
      };
    case "agent":
      return { title: `Agent wallet: ${action.op.kind}`, lines: [{ label: "Agent", value: action.agent, mono: true }] };
    case "demo-direct-install":
      return {
        title: "Call installModule directly",
        lines: [{ label: "Account", value: shortHex(account.address), mono: true }],
        warning: "Security demo. The account must reject this.",
      };
    case "demo-stranger":
      return {
        title: "Send 1 wei of ETH",
        lines: [{ label: "Account", value: shortHex(account.address), mono: true }],
        warning: "Security demo. The account must reject this.",
      };
  }
}

function routeOf(account: MockAccount, action: TxAction) {
  switch (action.kind) {
    case "transfer": {
      const view = accountView(account);
      const rules = view.rules.find((r) => r.token === action.token);
      const delay = describeSpend(rules, BigInt(action.amount), view.methods).delay;
      return delay > 0 ? ("schedule" as const) : ("execute" as const);
    }
    case "tighten":
      return "tighten" as const;
    case "cancel":
      return "cancel" as const;
    case "execute-scheduled":
      return "executeScheduled" as const;
    case "approve-recovery":
      return "approveRecovery" as const;
    case "demo-direct-install":
      return "direct" as const;
    case "demo-stranger":
      return "execute" as const;
    default:
      return "schedule" as const;
  }
}

function buildFrames(account: MockAccount, method: MethodRef, route: string, deploys: boolean): FrameView[] {
  const frames: FrameView[] = [];
  if (deploys) {
    frames.push({ index: 0, mode: "DEFAULT", target: account.address, label: "Deploy account" });
  }
  frames.push({
    index: frames.length,
    mode: "VERIFY",
    target: account.address,
    label: `${methodLabel(method)} check`,
  });
  frames.push({ index: frames.length, mode: "SENDER", target: account.address, label: route });
  return frames;
}

function mark(frames: FrameView[], failedIndex: number | null): FrameView[] {
  return frames.map((frame) => {
    if (failedIndex === null || frame.index < failedIndex) {
      return { ...frame, status: "ok", gasUsed: frame.mode === "VERIFY" ? "308214" : "61422" };
    }
    return { ...frame, status: frame.index === failedIndex ? "failed" : "skipped" };
  });
}

function prepare(state: MockState, body: TxPrepareRequest): TxPrepareResponse {
  const account = getAccount(state, body.account);
  const route = routeOf(account, body.action);
  const deploys = !account.deployed;
  const frames = buildFrames(account, body.method, route, deploys);
  const decoded = decodeAction(account, body.action);
  const root = body.method.kind === "world" ? (body.rootHint ?? state.root) : null;
  const sigHash = nextHash(state, "sig");
  const envelope = nextHash(state, "envelope");
  state.txs[envelope] = {
    envelope,
    account: account.address,
    action: body.action,
    method: body.method,
    frames,
    decoded,
    root,
    deploys,
  };
  return {
    ok: true,
    envelope,
    sigHash,
    method: body.method,
    route,
    decoded,
    frames,
    rootReference: root ? { sourceId: SOURCE_ID, slot: "1024", root } : null,
    deploys,
    sponsored: false,
    runAtOnce: false,
    runActionId: null,
  };
}

function reject(stage: Rejection["stage"], code: string, tx: StoredTx, frameMode: FrameView["mode"]): TxSendResponse {
  const failed = tx.frames.find((f) => f.mode === frameMode);
  const index = failed?.index ?? 0;
  return {
    ok: false,
    rejection: { stage, code, failedFrameIndex: index, frames: mark(tx.frames, index) },
  };
}

function send(state: MockState, body: TxSendRequest): TxSendResponse {
  const tx = state.txs[body.envelope];
  if (!tx) throw new ApiError("BAD_REQUEST", "Unknown mock envelope.", 400);
  const account = getAccount(state, tx.account);
  account.pending = refreshPending(account);
  const { action, method } = tx;

  if (body.witness.kind === "world") {
    if (BigInt(body.witness.nullifierHash) !== BigInt(account.owner)) {
      return reject("simulate", "NullifierMismatch", tx, "VERIFY");
    }
  }
  if (action.kind === "demo-direct-install") {
    return reject("simulate", "SenderFrameNotAllowed", tx, "VERIFY");
  }

  const worldOnly =
    action.kind === "install-passkey" || action.kind === "remove-passkey" || action.kind === "set-rules";
  if (worldOnly && method.kind !== "world") {
    return reject("simulate", "MethodNotAllowed", tx, "SENDER");
  }

  if (action.kind === "transfer") {
    const view = accountView(account);
    const rules = view.rules.find((r) => r.token === action.token);
    const amount = BigInt(action.amount);
    // Same order as _checkTransfer: the daily limit stops every method and every tier.
    if (rules?.daily && amount > BigInt(rules.daily.left)) {
      return reject("simulate", "DailyLimitReached", tx, "SENDER");
    }
    const rule = describeSpend(rules, amount, view.methods);
    const choice = rule.choices.find((c) => sameMethod(c.view.ref, method));
    if (rule.kind === "none") return reject("simulate", "NoTier", tx, "SENDER");
    if (!choice?.allowed) {
      // Same order as _authorizeTransfer: the mask first, then the synced check.
      const named = choice && rule.tier ? maskHas(rule.tier.methods, choice.view) : false;
      const code = named ? "SyncedNotAllowed" : "MethodNotAllowed";
      return reject("simulate", code, tx, "SENDER");
    }
    if (BigInt(account.balances[action.token] ?? "0") < amount) {
      return reject("simulate", "InsufficientFunds", tx, "SENDER");
    }
    if (rule.tierIndex !== null) {
      const tier = account.tiers[action.token][rule.tierIndex];
      tier.spent = (BigInt(tier.spent) + amount).toString();
    }
    countDaily(account, action.token, amount);
    if (rule.delay > 0) {
      schedule(state, account, tx, "transfer", rule.delay);
    } else {
      account.balances[action.token] = (BigInt(account.balances[action.token]) - amount).toString();
    }
  }

  if (action.kind === "install-passkey" || action.kind === "remove-passkey" || action.kind === "set-rules") {
    schedule(state, account, tx, "config", 172800);
  }

  if (action.kind === "tighten") {
    const old = BigInt(account.daily[action.token]?.limit ?? "0");
    const next = BigInt(action.dailyLimit);
    if (old > BigInt(0) && (next === BigInt(0) || next > old)) {
      return reject("simulate", "NotStricter", tx, "SENDER");
    }
    account.tiers[action.token] = action.tiers.map((t) => ({ ...t, spent: "0" }));
    setDaily(account, action.token, action.dailyLimit);
  }

  if (action.kind === "cancel") {
    const target = account.pending.find((p) => p.id === action.actionId);
    if (!target) return reject("simulate", "BadStatus", tx, "SENDER");
    if (target.cancelBy === "owner" && !sameMethod(method, accountView(account).owner)) {
      return reject("simulate", "OnlyOwnerMethod", tx, "SENDER");
    }
    account.pending = account.pending.filter((p) => p.id !== action.actionId);
  }

  if (action.kind === "execute-scheduled") {
    const target = account.pending.find((p) => p.id === action.actionId);
    if (!target) return reject("simulate", "BadStatus", tx, "SENDER");
    if (target.status === "waiting") return reject("simulate", "TooEarly", tx, "SENDER");
    if (target.status === "stale") return reject("simulate", "StaleVersion", tx, "SENDER");
    applyScheduled(state, account, target);
    account.pending = account.pending.filter((p) => p.id !== action.actionId);
  }

  account.deployed = true;
  const txHash = nextHash(state, "tx");
  const frames = mark(tx.frames, null);
  tx.frames = frames;
  state.txs[txHash] = tx;
  account.activity.unshift({
    txHash,
    title: tx.decoded.title,
    token: action.kind === "transfer" ? action.token : null,
    amount: action.kind === "transfer" ? action.amount : null,
    counterparty: action.kind === "transfer" ? action.to : null,
    direction: action.kind === "transfer" ? "out" : "none",
    method,
    state: "included",
    timestamp: now(),
  });
  return { ok: true, txHash, frames };
}

function schedule(state: MockState, account: MockAccount, tx: StoredTx, kind: PendingAction["kind"], realDelay: number) {
  const applied = Math.min(realDelay, DEMO_DELAY);
  const id = nextHash(state, "action");
  state.scheduled[id] = tx.action;
  account.pending.push({
    id,
    kind,
    status: "waiting",
    decoded: tx.decoded,
    proposedBy: tx.method,
    approvals: [],
    executeAfter: now() + applied,
    realDelay,
    appliedDelay: applied,
    cancelBy: "any",
  });
}

function applyScheduled(state: MockState, account: MockAccount, target: PendingAction) {
  const action = state.scheduled[target.id];
  if (!action) return;
  if (action.kind === "transfer") {
    const left = BigInt(account.balances[action.token] ?? "0") - BigInt(action.amount);
    account.balances[action.token] = (left < BigInt(0) ? BigInt(0) : left).toString();
  }
  if (action.kind === "install-passkey") {
    account.methods.push({
      ref: { kind: "passkey", slot: action.slot },
      validator: pad(`0x${action.slot.toString(16)}`, { size: 20 }),
      mask: 1 << action.slot,
      backup: action.backupEligible ? "synced" : "device-bound",
      owner: false,
    });
    account.configVersion += 1;
  }
  if (action.kind === "remove-passkey") {
    account.methods = account.methods.filter(
      (m) => !sameMethod(m.ref, { kind: "passkey", slot: action.slot }),
    );
    account.configVersion += 1;
  }
  if (action.kind === "set-rules") {
    account.tiers[action.token] = action.tiers.map((t) => ({ ...t, spent: "0" }));
    setDaily(account, action.token, action.dailyLimit);
    account.configVersion += 1;
  }
}

export async function mockRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  const state = load();
  const [route, query] = path.split("?");
  const address = new URLSearchParams(query).get("address") ?? "";
  const result = handle(state, method, route, query, address, body);
  save();
  return result as T;
}

function handle(
  state: MockState,
  method: string,
  route: string,
  query: string | undefined,
  address: string,
  body: unknown,
): unknown {
  if (route === API_ROUTES.info) {
    const info: InfoResponse = {
      network: "local",
      chainId: 1337,
      chainOnline: !state.offline,
      sidecarOnline: !state.offline,
      contractsDeployed: true,
      explorerUrl: "http://localhost:5173",
      rpcUrl: "http://localhost:8545",
      world: { mode: "dev" },
      tokens: TOKENS,
      gasSponsored: true,
    };
    return info;
  }

  if (state.offline) {
    throw new ApiError("CHAIN_OFFLINE", "The local chain does not answer.", 503);
  }

  switch (route) {
    case API_ROUTES.account:
      return accountView(getAccount(state, address));
    case API_ROUTES.activity: {
      const response: ActivityResponse = { items: getAccount(state, address).activity };
      return response;
    }
    case API_ROUTES.faucet: {
      const account = getAccount(state, (body as { address: Address }).address);
      const funded = [
        { token: ETH_TOKEN, amount: "100000000000000000" },
        { token: USDC, amount: "1000000000" },
      ];
      const hashes: Hex[] = [];
      for (const item of funded) {
        const held = BigInt(account.balances[item.token] ?? "0");
        account.balances[item.token] = (held + BigInt(item.amount)).toString();
        const txHash = nextHash(state, "faucet");
        hashes.push(txHash);
        const token = tokenOf(item.token);
        account.activity.unshift({
          txHash,
          title: `Received ${formatAmount(item.amount, token.decimals)} ${token.symbol}`,
          token: item.token,
          amount: item.amount,
          counterparty: null,
          direction: "in",
          method: null,
          state: "included",
          timestamp: now(),
        });
      }
      const response: FaucetResponse = { txHashes: hashes, funded };
      return response;
    }
    case API_ROUTES.rootPublish: {
      const root = (body as { root?: Hex }).root ?? state.root;
      state.root = root;
      const response: RootPublishResponse = {
        root,
        sourceId: SOURCE_ID,
        slot: "1024",
        txHash: nextHash(state, "root"),
      };
      return response;
    }
    case API_ROUTES.txPrepare:
      return prepare(state, body as TxPrepareRequest);
    case API_ROUTES.txSend:
      return send(state, body as TxSendRequest);
    case API_ROUTES.txStatus: {
      const hash = new URLSearchParams(query).get("hash") as Hex;
      const response: TxStatusResponse = {
        hash,
        state: "included",
        blockNumber: "1024",
        gasUsed: "369636",
        frames: state.txs[hash]?.frames ?? [],
        rejection: null,
      };
      return response;
    }
    case API_ROUTES.worldDevProof: {
      const { identity, signal } = body as WorldDevProofRequest;
      if (state.rootChangeNext) {
        state.rootChangeNext = false;
        state.root = nextHash(state, "root");
      }
      const response: WorldDevProofResponse = {
        proof: pad("0x01", { size: 256 }),
        merkleRoot: state.root,
        nullifierHash: nullifierOf(identity.trapdoor, identity.nullifier),
        signalHash: keccak256(stringToHex(signal)),
      };
      return response;
    }
    case API_ROUTES.worldVerify: {
      const request = body as WorldVerifyRequest;
      if (request.source !== "dev") {
        throw new ApiError("BAD_REQUEST", "The mock takes test identity proofs only.", 400);
      }
      const owner = request.proof.nullifierHash;
      const newAddress = `0x${keccak256(owner).slice(-40)}` as Address;
      const key = newAddress.toLowerCase();
      if (!state.accounts[key]) {
        state.accounts[key] = {
          address: newAddress,
          owner,
          deployed: false,
          balances: {},
          configVersion: 1,
          methods: [
            {
              ref: { kind: "world" },
              validator: "0x00000000000000000000000000000000000000a1",
              mask: 1,
              backup: null,
              owner: true,
            },
          ],
          tiers: {},
          daily: {},
          pending: [],
          activity: [],
        };
      }
      const response: WorldVerifyResponse = {
        ownerNullifierHash: owner,
        merkleRoot: request.proof.merkleRoot,
        address: newAddress,
        salt: pad("0x00", { size: 32 }),
      };
      return response;
    }
    case API_ROUTES.walletPlan: {
      const plan = body as WalletPlan;
      const seed = plan.owner.kind === "world" ? plan.owner.nullifierHash : plan.owner.publicKey.x;
      const newAddress = `0x${keccak256(seed).slice(-40)}` as Address;
      const slots = slotsOf(plan);
      const view = (slot: PasskeySlot, backupEligible: boolean, owner: boolean): MethodView => ({
        ref: { kind: "passkey", slot },
        validator: `0x00000000000000000000000000000000000000a${slot + 1}`,
        mask: owner ? 1 : 1 << slot,
        backup: backupEligible ? "synced" : "device-bound",
        owner,
      });
      const ownerView: MethodView =
        plan.owner.kind === "world"
          ? {
              ref: { kind: "world" },
              validator: "0x00000000000000000000000000000000000000a1",
              mask: 1,
              backup: null,
              owner: true,
            }
          : view(slots.owner as PasskeySlot, plan.owner.backupEligible, true);
      state.accounts[newAddress.toLowerCase()] = {
        address: newAddress,
        owner: seed,
        deployed: false,
        balances: {},
        configVersion: 1,
        methods: [
          ownerView,
          ...plan.extras.map((extra, index) => view(slots.extras[index], extra.backupEligible, false)),
        ],
        tiers: {},
        daily: plan.sends?.perDay ? { [USDC]: { limit: plan.sends.perDay, spent: "0", start: 0 } } : {},
        pending: [],
        activity: [],
      };
      const response: WalletPlanResponse = {
        address: newAddress,
        ownerSlot: slots.owner,
        extraSlots: slots.extras,
      };
      return response;
    }
    case API_ROUTES.worldRpContext:
      throw new ApiError("BAD_REQUEST", "The mock has no IDKit mode.", 400);
    default:
      throw new ApiError("NOT_FOUND", `The mock has no route for ${method} ${route}.`, 404);
  }
}
