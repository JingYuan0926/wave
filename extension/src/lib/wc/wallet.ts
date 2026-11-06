// WAVE on Whitechain Sepolia: reads from the chain and sends user operations through the relayer.
// The account is WaveAccount4337 (EntryPoint v0.7). The passkey signs the userOpHash; the
// relayer's paymaster pays the WBT gas.
import {
  concat,
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { CHAIN_ID, EXPLORER, RELAYER_URL, TOKENS, WC, publicClient, tokenByAddress, type TokenInfo } from "./config";
import { signHash, type StoredPasskey } from "./passkey";

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const PACKED_OP =
  "(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)";

const factoryAbi = parseAbi([
  "struct WaveTier { uint96 upTo; uint96 cap; uint32 delay; uint24 period; uint8 methods; }",
  "struct AgentRule { address token; WaveTier[] tiers; }",
  "function createAccount(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] rules) returns (address)",
  "function getAddress(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] rules) view returns (address)",
]);

const accountAbi = parseAbi([
  "struct WaveTier { uint96 upTo; uint96 cap; uint32 delay; uint24 period; uint8 methods; }",
  "struct Pending { bytes32 callsHash; uint40 notBefore; uint40 createdAt; uint32 version; uint8 status; uint8 kind; uint8 approvals; uint8 proposerBit; }",
  "function execute(bytes32 mode, bytes executionCalldata)",
  "function schedule(uint8 kind, bytes batch, bytes32 salt) returns (bytes32)",
  "function cancel(bytes32 id)",
  "function executeScheduled(bytes32 id, bytes batch)",
  "function tiersOf(address token) view returns (WaveTier[])",
  "function spentOf(address token, uint256 tierIndex) view returns (uint96)",
  "function configVersion() view returns (uint32)",
  "function pendingOf(bytes32 id) view returns (Pending)",
  "event Scheduled(bytes32 indexed id, uint8 kind, address proposer, uint40 notBefore, uint32 version, bytes batch)",
  "event Executed(bytes32 indexed id)",
  "event Cancelled(bytes32 indexed id, address validator)",
]);

const entryPointAbi = parseAbi([
  `function getUserOpHash(${PACKED_OP} op) view returns (bytes32)`,
  "function getNonce(address sender, uint192 key) view returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const EXECUTE_USER_OP: Hex = "0x8dd7712f";
const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
const BATCH = parseAbiParameters("(address target, uint256 value, bytes callData)[]");
const STATUS_QUEUED = 2;

function need(): NonNullable<typeof WC> {
  if (!WC) throw new Error("WAVE is not deployed on Whitechain Sepolia yet.");
  return WC;
}

// ---------------------------------------------------------------------------
// Wallet address and rules
// ---------------------------------------------------------------------------

/** The setup rules. The wallet address commits to them, so they must match the factory call. */
function rulesArg() {
  return need().rules.map((r) => ({
    token: r.token,
    tiers: r.tiers.map((t) => ({ upTo: BigInt(t.upTo), cap: BigInt(t.cap), delay: t.delay, period: t.period, methods: t.methods })),
  }));
}

function createArgs(p: StoredPasskey) {
  return [p.x, p.y, p.backupEligible, true, rulesArg()] as const;
}

export async function walletAddress(p: StoredPasskey): Promise<Address> {
  return publicClient.readContract({ address: need().factory, abi: factoryAbi, functionName: "getAddress", args: createArgs(p) });
}

export async function isDeployed(address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return !!code && code !== "0x";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const toUnits = (amount: number, decimals: number) => BigInt(Math.round(amount * 10 ** decimals));
export const fromUnits = (units: bigint, decimals: number) => Number(units) / 10 ** decimals;

/** Parallel reads, without Multicall3: a token with no code reads as 0 instead of failing all. */
export async function readBalances(address: Address): Promise<Record<string, number>> {
  const results = await Promise.allSettled(
    TOKENS.map((t) => publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })),
  );
  const out: Record<string, number> = {};
  TOKENS.forEach((t, i) => {
    const r = results[i];
    out[t.symbol] = r.status === "fulfilled" ? fromUnits(r.value, t.decimals) : 0;
  });
  return out;
}

export type ChainTier = { upTo: bigint; cap: bigint; delay: number; period: number; methods: number; spent: bigint };

/** The live tiers and period counters. Before the first transaction they are the setup rules. */
export async function readTiers(address: Address, deployed: boolean): Promise<Record<string, ChainTier[]>> {
  const out: Record<string, ChainTier[]> = {};
  for (const t of TOKENS) {
    const rule = need().rules.find((r) => isAddressEqual(r.token, t.address));
    let tiers: Omit<ChainTier, "spent">[] = (rule?.tiers ?? []).map((x) => ({ ...x, upTo: BigInt(x.upTo), cap: BigInt(x.cap) }));
    let spent: bigint[] = tiers.map(() => 0n);
    if (deployed) {
      const live = await publicClient.readContract({ address, abi: accountAbi, functionName: "tiersOf", args: [t.address] });
      tiers = live.map((x) => ({ upTo: x.upTo, cap: x.cap, delay: x.delay, period: x.period, methods: x.methods }));
      spent = await Promise.all(
        tiers.map((_, i) => publicClient.readContract({ address, abi: accountAbi, functionName: "spentOf", args: [t.address, BigInt(i)] })),
      );
    }
    out[t.symbol] = tiers.map((x, i) => ({ ...x, spent: spent[i] }));
  }
  return out;
}

/** The same choice as WavePolicy._selectTier: the first tier whose upTo covers the amount and
 *  whose cap still has room. Null means no tier allows it (NoTier). */
export function selectTier(tiers: ChainTier[], units: bigint) {
  let capSkipped = false;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (units > t.upTo) continue;
    if (t.cap !== 0n && units + t.spent > t.cap) {
      capSkipped = true;
      continue;
    }
    return { index: i, tier: t, capSkipped };
  }
  return null;
}

export type Activity = {
  hash: Hex;
  token: TokenInfo;
  direction: "in" | "out";
  counterparty: Address;
  amount: number;
  timestamp: number;
};

/** Token transfers of the wallet, newest first, from the Blockscout API. */
export async function readActivity(address: Address): Promise<Activity[]> {
  const url = `${EXPLORER}/api?module=account&action=tokentx&address=${address}&page=1&offset=50&sort=desc`;
  const res = await fetch(url);
  const j = (await res.json()) as { result?: unknown };
  if (!Array.isArray(j.result)) return [];
  const out: Activity[] = [];
  for (const r of j.result as Record<string, string>[]) {
    const token = tokenByAddress(r.contractAddress);
    if (!token) continue;
    const out_ = r.from.toLowerCase() === address.toLowerCase();
    out.push({
      hash: r.hash as Hex,
      token,
      direction: out_ ? "out" : "in",
      counterparty: (out_ ? r.to : r.from) as Address,
      amount: fromUnits(BigInt(r.value), token.decimals),
      timestamp: Number(r.timeStamp) * 1000,
    });
  }
  return out;
}

export type ChainPending = {
  id: Hex;
  batch: Hex;
  notBefore: number;
  transfers: { token: TokenInfo; to: Address; amount: number }[];
};

/** Queued actions: Scheduled events whose id is still QUEUED in the account. */
export async function readPending(address: Address): Promise<ChainPending[]> {
  const from = need().deployedAtBlock;
  const url = `${EXPLORER}/api?module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${address}`;
  const res = await fetch(url);
  const j = (await res.json()) as { result?: unknown };
  if (!Array.isArray(j.result)) return [];
  const scheduled: { id: Hex; batch: Hex; notBefore: number }[] = [];
  for (const log of j.result as { topics: (Hex | null)[]; data: Hex }[]) {
    const topics = log.topics.filter((t): t is Hex => !!t);
    try {
      const ev = decodeEventLog({ abi: accountAbi, data: log.data, topics: topics as [Hex, ...Hex[]] });
      if (ev.eventName === "Scheduled") {
        scheduled.push({ id: ev.args.id, batch: ev.args.batch, notBefore: Number(ev.args.notBefore) * 1000 });
      }
    } catch {
      // Another event.
    }
  }
  if (scheduled.length === 0) return [];
  const status = await Promise.all(
    scheduled.map((s) => publicClient.readContract({ address, abi: accountAbi, functionName: "pendingOf", args: [s.id] })),
  );
  const out: ChainPending[] = [];
  scheduled.forEach((s, i) => {
    if (status[i].status !== STATUS_QUEUED) return;
    const calls = decodeAbiParameters(BATCH, s.batch)[0];
    const transfers = calls.flatMap((c) => {
      const token = tokenByAddress(c.target);
      if (!token || c.callData.length < 138) return [];
      const [to, amount] = decodeAbiParameters(parseAbiParameters("address, uint256"), `0x${c.callData.slice(10)}`);
      return [{ token, to, amount: fromUnits(amount, token.decimals) }];
    });
    out.push({ id: s.id, batch: s.batch, notBefore: s.notBefore, transfers });
  });
  return out.sort((a, b) => a.notBefore - b.notBefore);
}

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

type PackedOp = {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type SendResult = {
  txHash: Hex;
  explorerUrl: string;
  /** False when the operation ran but the account call reverted (for example a rule refused it). */
  success: boolean;
  scheduledId?: Hex;
};

export class RelayerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RELAYER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RelayerError("RELAYER_OFFLINE", `The WAVE relayer at ${RELAYER_URL} does not answer. Start it with npm run dev in the repo root.`);
  }
  const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!res.ok || j.error) throw new RelayerError(j.error?.code ?? "RELAYER_ERROR", j.error?.message ?? `The relayer answered ${res.status}.`);
  return j;
}

const toAbiOp = (op: PackedOp) => ({ ...op, nonce: BigInt(op.nonce), preVerificationGas: BigInt(op.preVerificationGas) });

/** Builds the operation, gets it sponsored, signs it with the passkey and sends it. */
async function submit(p: StoredPasskey, inner: Hex): Promise<SendResult> {
  const d = need();
  const sender = await walletAddress(p);
  const deployed = await isDeployed(sender);
  const nonce = await publicClient.readContract({ address: d.entryPoint, abi: entryPointAbi, functionName: "getNonce", args: [sender, 0n] });
  const initCode: Hex = deployed
    ? "0x"
    : concat([d.factory, encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: createArgs(p) })]);
  const op: PackedOp = {
    sender,
    nonce: toHex(nonce),
    initCode,
    callData: concat([EXECUTE_USER_OP, inner]),
    accountGasLimits: "0x",
    preVerificationGas: "0x0",
    gasFees: "0x",
    paymasterAndData: "0x",
    signature: "0x",
  };

  const { op: sponsored } = await post<{ op: PackedOp }>("/api/wc/sponsor", { op });
  // The relayer fills gas and paymaster fields only. Refuse anything else it changed.
  if (
    !isAddressEqual(sponsored.sender, op.sender) ||
    BigInt(sponsored.nonce) !== nonce ||
    sponsored.initCode.toLowerCase() !== op.initCode.toLowerCase() ||
    sponsored.callData.toLowerCase() !== op.callData.toLowerCase() ||
    !sponsored.paymasterAndData.toLowerCase().startsWith(d.paymaster.toLowerCase())
  ) {
    throw new RelayerError("RELAYER_CHANGED_OP", "The relayer changed the transaction. Nothing was signed.");
  }

  // The chain computes the hash, not the relayer.
  const hash = await publicClient.readContract({ address: d.entryPoint, abi: entryPointAbi, functionName: "getUserOpHash", args: [toAbiOp(sponsored)] });
  const webauthn = await signHash(hash, p);
  const signature = encodeAbiParameters(parseAbiParameters("address, bytes"), [d.passkeyValidator, webauthn]);
  return post<SendResult>("/api/wc/send", { op: { ...sponsored, signature } });
}

function transferCall(to: Address, units: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] });
}

/** A transfer that its tier allows at once. */
export function sendNow(p: StoredPasskey, token: TokenInfo, to: Address, units: bigint) {
  const exec = encodePacked(["address", "uint256", "bytes"], [token.address, 0n, transferCall(to, units)]);
  return submit(p, encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [MODE_SINGLE, exec] }));
}

/** A transfer whose tier has a delay: it goes into the account's delay queue. */
export async function sendScheduled(p: StoredPasskey, token: TokenInfo, to: Address, units: bigint): Promise<SendResult> {
  const sender = await walletAddress(p);
  const batch = encodeAbiParameters(BATCH, [[{ target: token.address, value: 0n, callData: transferCall(to, units) }]]);
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const version = (await isDeployed(sender))
    ? await publicClient.readContract({ address: sender, abi: accountAbi, functionName: "configVersion" })
    : 0;
  const result = await submit(p, encodeFunctionData({ abi: accountAbi, functionName: "schedule", args: [0, batch, salt] }));
  const scheduledId = keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, address, uint8, bytes32, bytes32, uint32"), [
      BigInt(CHAIN_ID),
      sender,
      0,
      keccak256(batch),
      salt,
      version,
    ]),
  );
  return { ...result, scheduledId };
}

export function cancelPending(p: StoredPasskey, id: Hex) {
  return submit(p, encodeFunctionData({ abi: accountAbi, functionName: "cancel", args: [id] }));
}

export function runPending(p: StoredPasskey, id: Hex, batch: Hex) {
  return submit(p, encodeFunctionData({ abi: accountAbi, functionName: "executeScheduled", args: [id, batch] }));
}

/** Mints WAVE test USDT (tUSDT) to the wallet. The relayer pays the gas. */
export function claimTestTokens(address: Address) {
  return post<{ txHash: Hex; explorerUrl: string; amount: string }>("/api/wc/faucet", { address });
}
