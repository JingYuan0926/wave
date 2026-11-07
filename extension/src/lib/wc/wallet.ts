// WAVE on Whitechain Sepolia: reads from the chain and sends user operations through the relayer.
// The account is WaveAccount4337 (EntryPoint v0.7). The passkey signs the userOpHash, and the
// relayer's paymaster pays the WBT gas.
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  isAddressEqual,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { RELAYER_URL, USDT, clientOf, type WcDeployment } from "./config";
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
  "function execute(bytes32 mode, bytes executionCalldata)",
  "function tiersOf(address token) view returns (WaveTier[])",
  "function spentOf(address token, uint256 tierIndex) view returns (uint96)",
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

// ---------------------------------------------------------------------------
// Wallet address and rules
// ---------------------------------------------------------------------------

/** The setup rules. The wallet address commits to them, so they must match the factory call. */
function rulesArg(d: WcDeployment) {
  return d.rules.map((r) => ({
    token: r.token,
    tiers: r.tiers.map((t) => ({ upTo: BigInt(t.upTo), cap: BigInt(t.cap), delay: t.delay, period: t.period, methods: t.methods })),
  }));
}

function createArgs(d: WcDeployment, p: StoredPasskey) {
  return [p.x, p.y, p.backupEligible, true, rulesArg(d)] as const;
}

export async function walletAddress(d: WcDeployment, p: StoredPasskey): Promise<Address> {
  return clientOf(d).readContract({ address: d.factory, abi: factoryAbi, functionName: "getAddress", args: createArgs(d, p) });
}

export async function isDeployed(d: WcDeployment, address: Address): Promise<boolean> {
  const code = await clientOf(d).getCode({ address });
  return !!code && code !== "0x";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A failed read throws. It must never look like a balance of zero. */
export async function readUsdtBalance(d: WcDeployment, address: Address): Promise<bigint> {
  return clientOf(d).readContract({ address: USDT.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

export type ChainTier = { upTo: bigint; cap: bigint; delay: number; period: number; methods: number; spent: bigint };

/** The live USDT tiers and period counters. Before the first transaction they are the setup rules. */
export async function readUsdtTiers(d: WcDeployment, address: Address, deployed: boolean): Promise<ChainTier[]> {
  const client = clientOf(d);
  if (!deployed) {
    const rule = d.rules.find((r) => isAddressEqual(r.token, USDT.address));
    return (rule?.tiers ?? []).map((t) => ({ ...t, upTo: BigInt(t.upTo), cap: BigInt(t.cap), spent: BigInt(0) }));
  }
  const live = await client.readContract({ address, abi: accountAbi, functionName: "tiersOf", args: [USDT.address] });
  return Promise.all(
    live.map(async (t, i) => {
      const args = [USDT.address, BigInt(i)] as const;
      const spent = await client.readContract({ address, abi: accountAbi, functionName: "spentOf", args });
      return { upTo: t.upTo, cap: t.cap, delay: t.delay, period: t.period, methods: t.methods, spent };
    }),
  );
}

/** The same choice as WavePolicy._selectTier: the first tier whose upTo covers the amount and
 *  whose cap still has room. Null means no tier allows it. */
export function selectTier(tiers: ChainTier[], units: bigint): ChainTier | null {
  for (const t of tiers) {
    if (units > t.upTo) continue;
    if (t.cap !== BigInt(0) && units + t.spent > t.cap) continue;
    return t;
  }
  return null;
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
  /** False when the operation ran but the account call reverted, or when no receipt came yet. */
  success: boolean;
  /** True when the transaction left the server but no receipt came in time. */
  pending?: boolean;
};

/** "sponsor" and "device" come before anything leaves this page. "chain" may reach the chain. */
export type SendStep = "sponsor" | "device" | "chain";

/** Codes that prove that no transaction left the relayer. */
const NOTHING_SENT = new Set([
  "BAD_NONCE",
  "BAD_REQUEST",
  "BUDGET_USED",
  "NOT_DEPLOYED",
  "NOT_SPONSORED",
  "OP_REJECTED",
  "RELAYER_CHANGED_OP",
  "RELAYER_MISMATCH",
  "RELAYER_NOT_SET",
]);

export class RelayerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  get nothingSent() {
    return NOTHING_SENT.has(this.code);
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
    throw new RelayerError("RELAYER_OFFLINE", "The WAVE server does not answer.");
  }
  const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!res.ok || j.error) throw new RelayerError(j.error?.code ?? "RELAYER_ERROR", j.error?.message ?? `The server answered ${res.status}.`);
  return j;
}

const toAbiOp = (op: PackedOp) => ({ ...op, nonce: BigInt(op.nonce), preVerificationGas: BigInt(op.preVerificationGas) });

/** Builds the operation, gets it sponsored, signs it with the passkey and sends it. */
async function submit(d: WcDeployment, p: StoredPasskey, inner: Hex, onStep: (step: SendStep) => void): Promise<SendResult> {
  const client = clientOf(d);
  onStep("sponsor");
  const sender = await walletAddress(d, p);
  const deployed = await isDeployed(d, sender);
  const nonce = await client.readContract({ address: d.entryPoint, abi: entryPointAbi, functionName: "getNonce", args: [sender, BigInt(0)] });
  const initCode: Hex = deployed
    ? "0x"
    : concat([d.factory, encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: createArgs(d, p) })]);
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
    throw new RelayerError("RELAYER_CHANGED_OP", "The server changed the transaction. Nothing was signed.");
  }

  // The chain computes the hash, not the relayer.
  const hash = await client.readContract({ address: d.entryPoint, abi: entryPointAbi, functionName: "getUserOpHash", args: [toAbiOp(sponsored)] });
  onStep("device");
  const webauthn = await signHash(hash, p);
  const signature = encodeAbiParameters(parseAbiParameters("address, bytes"), [d.passkeyValidator, webauthn]);
  onStep("chain");
  return post<SendResult>("/api/wc/send", { op: { ...sponsored, signature } });
}

/** A USDT transfer that its tier allows at once. */
export function sendUsdt(d: WcDeployment, p: StoredPasskey, to: Address, units: bigint, onStep: (step: SendStep) => void) {
  const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, units] });
  const exec = encodePacked(["address", "uint256", "bytes"], [USDT.address, BigInt(0), call]);
  return submit(d, p, encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [MODE_SINGLE, exec] }), onStep);
}
