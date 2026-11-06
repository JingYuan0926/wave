/**
 * The contract between the web UI and the route handlers in app/api.
 *
 * Rules for every route:
 * 1. All big numbers travel as decimal strings. JSON has no BigInt.
 * 2. A "base unit" string is the integer amount in the token's smallest unit.
 * 3. A transport or server failure returns a non-2xx status and an ApiErrorBody.
 * 4. A rejection by the rules or by the chain is a normal result. It returns
 *    status 200 and `{ ok: false, rejection }`.
 */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;
/** Integer amount in the smallest unit of a token, as a decimal string. */
export type BaseUnits = string;
/** Seconds since the Unix epoch. */
export type UnixSeconds = number;

/** The address that stands for native ETH in rules and balances. */
export const ETH_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/** The owner method is bit 0 of a tier's method mask. Other bits come from `methodBitOf`. */
export const OWNER_METHOD_MASK = 1;
export const PASSKEY_SLOTS = [1, 2, 3] as const;
export type PasskeySlot = (typeof PASSKEY_SLOTS)[number];

/** The agent key is bit 6 of a tier's method mask. Only an agent wallet can hold this method. */
export const AGENT_METHOD_MASK = 0x40;

/** The World ID action for every WAVE proof. */
export const WORLD_ACTION = "wave-approve";
/** The IDKit signal of the creation scan. Transaction scans use sig_hash. */
export const CREATE_SIGNAL = "wave-create";

export const API_ROUTES = {
  info: "/api/info",
  account: "/api/account",
  faucet: "/api/faucet",
  runScheduled: "/api/tx/run-scheduled",
  rootPublish: "/api/root/publish",
  txPrepare: "/api/tx/prepare",
  txSend: "/api/tx/send",
  txStatus: "/api/tx/status",
  worldRpContext: "/api/world/rp-context",
  worldVerify: "/api/world/verify",
  walletPlan: "/api/wallet/plan",
  worldDevProof: "/api/world/dev-proof",
  activity: "/api/activity",
  agents: "/api/agents",
  agentSpend: "/api/agents/spend",
  agentCheckpoint: "/api/agents/checkpoint",
  agentOperation: "/api/agents/operation",
  agentDecision: "/api/agents/decision",
  agentConfirmToken: "/api/agents/confirm-token",
  mcpAgent: "/api/mcp/agent",
  mcpSend: "/api/mcp/send",
  agentPassDevice: "/api/agent-pass/device",
  agentPassStart: "/api/agent-pass/start",
  agentPassStatus: "/api/agent-pass/status",
} as const;

/** Body of every non-2xx response. */
export type ApiErrorBody = {
  error: {
    /** For example CHAIN_OFFLINE, BAD_REQUEST, NOT_DEPLOYED. */
    code: string;
    message: string;
  };
};

// Shared values

export type MethodRef =
  | { kind: "world" }
  | { kind: "passkey"; slot: PasskeySlot }
  /** The secp256k1 credential of an agent wallet. */
  | { kind: "agent" };

export type TokenInfo = {
  /** ETH_TOKEN for native ETH. */
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** True for TestUSDC, so the UI can label it as a test token. */
  isTest: boolean;
};

export type TokenBalance = {
  token: Address;
  amount: BaseUnits;
};

/** One spending tier, as the owner writes it. */
export type Tier = {
  /** Largest amount per transfer, in base units. */
  upTo: BaseUnits;
  /** Total per period, in base units. "0" means no cap. */
  cap: BaseUnits;
  /** Seconds before the transfer runs. 0 means at once. */
  delay: number;
  /** Length of the cap period in seconds. 0 means no period. */
  period: number;
  /** Method bits 0 to 6. The route splits bit 7 of the onchain byte into `small`. */
  methods: number;
  /** A synced passkey approves small tiers only. */
  small: boolean;
};

/** A tier as read from the chain, with its live counter. */
export type TierView = Tier & {
  /** Amount counted in the current period, in base units. */
  spent: BaseUnits;
  /** End of the current period. Null when the tier has no period. */
  periodEndsAt: UnixSeconds | null;
};

/** The hard daily total of one token. All methods and all tiers share it. */
export type DailyView = {
  limit: BaseUnits;
  /** Amount counted in the current 24 hours. */
  spent: BaseUnits;
  /** Amount that can still go out in the current 24 hours. */
  left: BaseUnits;
  /** The end of the current 24 hours. Null when no send started a window. */
  resetsAt: UnixSeconds | null;
};

export type TokenRules = {
  token: Address;
  /** Empty means the default rule: the owner method only, no delay. */
  tiers: TierView[];
  /** Null means no daily limit. */
  daily: DailyView | null;
};

export type PasskeyBackup = "synced" | "device-bound";

export type MethodView = {
  ref: MethodRef;
  validator: Address;
  /** The single-bit mask from `methodBitOf(validator)`. It is not the slot number. */
  mask: number;
  /** Set for passkeys only. */
  backup: PasskeyBackup | null;
  /** True for the owner method. It approves big sends and changes to the wallet. */
  owner: boolean;
};

// Scheduled actions

export type PendingKind = "transfer" | "config" | "sensitive" | "recovery";

export type PendingStatus =
  /** Recovery only. It waits for a second distinct method. */
  | "needs-approval"
  /** The delay runs. */
  | "waiting"
  /** The delay is over. Execute can run. */
  | "ready"
  /** A config version change invalidated it. */
  | "stale";

/** Human text that the server decodes from the built calls, not from the request. */
export type DecodedAction = {
  title: string;
  lines: { label: string; value: string; mono?: boolean }[];
  /** A plain warning for the owner, if the action is sensitive. */
  warning?: string;
};

export type PendingAction = {
  /** The action hash. */
  id: Hex;
  kind: PendingKind;
  status: PendingStatus;
  decoded: DecodedAction;
  proposedBy: MethodRef;
  /** Distinct approvals for a recovery action. Empty otherwise. */
  approvals: MethodRef[];
  /** Earliest execution time. Null until the second recovery approval. */
  executeAfter: UnixSeconds | null;
  /** The real delay in seconds, for the label "real: 48 hours". */
  realDelay: number;
  /** The delay that applies to this account, after the demo delay. */
  appliedDelay: number;
  /** "any" means any enrolled method. "owner" means the owner method only. */
  cancelBy: "any" | "owner";
};

export type RecoveryView = {
  /** Enrolled methods other than the owner method. */
  otherMethods: number;
  /** Two distinct other methods can run a recovery. */
  available: boolean;
};

// Frames and rejections

export type FrameView = {
  index: number;
  mode: "VERIFY" | "SENDER" | "DEFAULT";
  target: Address;
  /** Short text, for example "World ID check" or "execute". */
  label: string;
  /** Set after simulation or inclusion. */
  status?: "ok" | "failed" | "skipped";
  gasUsed?: string;
};

export type RejectionStage = "prepare" | "sponsor" | "simulate" | "sidecar" | "chain";

export type Rejection = {
  stage: RejectionStage;
  /**
   * The custom error name from the revert data, for example MethodNotAllowed.
   * Validators return APPROVE_NONE with no error data. For those failures the
   * route compares the witness and sets NullifierMismatch, RootNotCommitted,
   * RootSourceMismatch or ValidationFailed. See lib/ui/rejections.ts.
   */
  code: string;
  /** Decoded custom error arguments, as strings. */
  args?: Record<string, string>;
  /** Raw detail from the sidecar or the simulator. */
  message?: string;
  failedFrameIndex?: number;
  haltReason?: string;
  frames?: FrameView[];
  /** Set when the chain mined the failed tx. A failure before the mempool has no hash. */
  txHash?: Hex;
};

export type RootReference = {
  sourceId: Hex;
  slot: string;
  root: Hex;
};

// World ID

/** The same shape for IDKit and for the local test identity. */
export type WorldProof = {
  /** ABI encoded uint256[8]. */
  proof: Hex;
  merkleRoot: Hex;
  nullifierHash: Hex;
  signalHash: Hex;
};

/** Random secrets for the local test identity. They stay in localStorage. */
export type DevIdentity = {
  trapdoor: Hex;
  nullifier: Hex;
};

export type WorldEnvironment = "production" | "staging" | "sandbox";

export type WorldConfig =
  | { mode: "dev" }
  | {
      mode: "idkit";
      appId: `app_${string}`;
      rpId: string;
      environment: WorldEnvironment;
    };

export type TxWitness =
  | {
      kind: "world";
      root: Hex;
      nullifierHash: Hex;
      proof: Hex;
    }
  | {
      kind: "passkey";
      slot: PasskeySlot;
      /** The padded 512-byte witness from lib/ui/passkey.ts. */
      data: Hex;
    }
  | {
      kind: "agent";
      /** r || s || v over sig_hash. 65 bytes. */
      data: Hex;
    };

// GET /api/info

export type InfoResponse = {
  /** WAVE_NETWORK in .env.local. */
  network: "local" | "devnet";
  chainId: number;
  /** Network reachability. The route returns 200 with these false. */
  chainOnline: boolean;
  sidecarOnline: boolean;
  /** False until the contracts are deployed to the local stack. */
  contractsDeployed: boolean;
  explorerUrl: string;
  /** RPC URL for the explorer deep link `/tx/<hash>?node=<rpcUrl>`. */
  rpcUrl: string;
  world: WorldConfig;
  tokens: TokenInfo[];
  /** True on the local network only. The gas station pays for every wallet. */
  gasSponsored: boolean;
};

// GET /api/account?address=0x...

/** The server enforces this budget before it signs. The chain does not see it. */
export type SponsorView = {
  /** Transactions of this wallet today, in UTC. */
  used: number;
  limit: number;
  /** True if the gas station cannot pay for one more transaction. */
  stationEmpty: boolean;
};

export type AccountResponse = {
  address: Address;
  deployed: boolean;
  balances: TokenBalance[];
  configVersion: string;
  /** The clone value: seconds, 0 for real delays, or NO_WAIT. Use `waitSeconds` for text. */
  demoDelay: number;
  /** The wait that the owner chose, in seconds. 0 is no wait. Null means real delays. */
  waitSeconds: number | null;
  /** The World ID owner on the chain. Null for a passkey owner, and until the wallet deploys. */
  ownerNullifierHash: Hex | null;
  /** The owner method of this wallet. */
  owner: MethodRef;
  /** The public key x of an owner passkey. A recovery can change it. Null for World ID. */
  ownerKeyX: Hex | null;
  methods: MethodView[];
  rules: TokenRules[];
  pending: PendingAction[];
  recovery: RecoveryView;
  /** Null when the wallet pays its own gas. */
  sponsor: SponsorView | null;
};

// POST /api/tx/run-scheduled. Local network only. It needs no approval: the owner approved the
// action when it was queued, and the contract lets anyone run it after the delay.

export type RunScheduledRequest = { account: Address; actionId: Hex };

export type RunScheduledResponse = { txHash: Hex };

// POST /api/faucet

export type FaucetRequest = { address: Address };

export type FaucetResponse = {
  /** One transaction hash per token funded. */
  txHashes: Hex[];
  funded: TokenBalance[];
};

// POST /api/root/publish

export type RootPublishRequest = {
  /** The root to publish. Absent means the latest root for the World mode. */
  root?: Hex;
};

export type RootPublishResponse = {
  root: Hex;
  sourceId: Hex;
  /** Slot of the publish. */
  slot: string;
  txHash: Hex;
};

// POST /api/tx/prepare

export type RecoveryChange =
  | { kind: "owner"; nullifierHash: Hex }
  /** The owner method is a passkey. The new passkey replaces it. */
  | { kind: "owner-key"; publicKey: { x: Hex; y: Hex }; backupEligible: boolean }
  | { kind: "root-source"; sourceId: Hex };

/** One token and its tiers, for the first setup of an agent wallet. */
export type AgentRule = { token: Address; tiers: Tier[] };

/** What the main wallet does to one of its agent wallets. */
export type AgentAdminOp =
  /** The owner method, no delay. The server sets the agent key and deploys the wallet first. */
  | { kind: "create"; salt: Hex; rules: AgentRule[] }
  /** Any enrolled method, at once. */
  | { kind: "revoke" }
  | { kind: "pause" }
  | { kind: "tighten"; token: Address; tiers: Tier[] }
  | { kind: "withdraw"; token: Address; amount: BaseUnits }
  /** The owner method. These go through the 48 hour queue. */
  | { kind: "unpause" }
  | { kind: "set-tiers"; token: Address; tiers: Tier[] }
  | { kind: "set-key" };

export type TxAction =
  /** The server sends it to execute, or to schedule if the tier has a delay. */
  | { kind: "transfer"; token: Address; to: Address; amount: BaseUnits }
  | {
      kind: "install-passkey";
      slot: PasskeySlot;
      publicKey: { x: Hex; y: Hex };
      backupEligible: boolean;
    }
  | { kind: "remove-passkey"; slot: PasskeySlot }
  /**
   * Stricter tiers and a daily limit that is new, the same or lower. Any enrolled method. It applies
   * at once. `dailyLimit` is the whole value, and "0" means no limit.
   */
  | { kind: "tighten"; token: Address; tiers: Tier[]; dailyLimit: BaseUnits }
  /** Looser rules. The owner method. The change goes through the 48 hour queue. "0" removes the limit. */
  | { kind: "set-rules"; token: Address; tiers: Tier[]; dailyLimit: BaseUnits }
  | { kind: "cancel"; actionId: Hex }
  | { kind: "execute-scheduled"; actionId: Hex }
  | { kind: "approve-recovery"; actionId: Hex }
  /** A device-bound passkey proposes a fallback change. A second one must approve it. */
  | { kind: "propose-recovery"; change: RecoveryChange }
  | { kind: "agent"; agent: Address; op: AgentAdminOp }
  /** Security demo: a SENDER frame that calls installModule directly. */
  | { kind: "demo-direct-install" }
  /** Security demo: 1 wei of ETH. The stranger's proof must fail before any rule runs. */
  | { kind: "demo-stranger" };

export type TxPrepareRequest = {
  account: Address;
  /** Required while the account has no code. The first tx deploys it. */
  deployment?: WalletPlan;
  action: TxAction;
  method: MethodRef;
  /** The last `merkle_root` seen. World ID transactions reference this root. */
  rootHint?: Hex;
};

export type TxPrepared = {
  ok: true;
  /** Serialized tx with a placeholder witness of the final length. */
  envelope: Hex;
  /** The World ID signal and the WebAuthn challenge. */
  sigHash: Hex;
  method: MethodRef;
  /** The account function that the SENDER frame calls. */
  route: "execute" | "schedule" | "tighten" | "cancel" | "executeScheduled" | "approveRecovery" | "direct";
  decoded: DecodedAction;
  frames: FrameView[];
  /** Present on World ID transactions. */
  rootReference: RootReference | null;
  /** True when this tx deploys the account in a DEFAULT frame. Devnet only. */
  deploys: boolean;
  /** True when the gas station pays for this tx. */
  sponsored: boolean;
  /** True if the wallet has no wait and the app must run this action right after it is approved. */
  runAtOnce: boolean;
  /** The action to run. A new `schedule` gets its ID from the send response instead. */
  runActionId: Hex | null;
};

export type TxPrepareResponse = TxPrepared | { ok: false; rejection: Rejection };

// POST /api/tx/send

export type TxSendRequest = {
  envelope: Hex;
  method: MethodRef;
  witness: TxWitness;
};

export type TxSendResponse =
  /** `scheduledId` is set when this transaction queued an action. */
  | { ok: true; txHash: Hex; frames: FrameView[]; scheduledId?: Hex }
  | { ok: false; rejection: Rejection };

// GET /api/tx/status?hash=0x...

export type TxState = "queued" | "included" | "failed" | "dropped";

export type TxStatusResponse = {
  hash: Hex;
  state: TxState;
  blockNumber: string | null;
  gasUsed: string | null;
  frames: FrameView[];
  rejection: Rejection | null;
};

// POST /api/wallet/plan

/** A passkey or security key, as the device reported it at enrolment. */
export type PasskeyFacts = {
  publicKey: { x: Hex; y: Hex };
  /** BE at enrolment. True means a synced passkey. */
  backupEligible: boolean;
};

/** The ticked method that ranks highest. Rank: World ID, security key, passkey. */
export type PlanOwner = { kind: "world"; nullifierHash: Hex } | ({ kind: "passkey" } & PasskeyFacts);

/** A ticked method that is not the owner method. It approves sends up to `limit` at once. */
/** Test scripts set `limit`. The app sets `sends` on the plan instead. */
export type PlanExtra = PasskeyFacts & { limit?: BaseUnits };

/**
 * How the wallet approves sends of test tokens. A method is an index: 0 is the owner method, and N is
 * extra method N. `perDay` is the hard daily total. Null or no value means no daily limit.
 */
export type PlanSends =
  | { kind: "every"; method: number; perDay?: BaseUnits | null }
  | { kind: "limit"; amount: BaseUnits; perDay: BaseUnits | null; lower: number; upper: number };

/** The waits on the creation screen, in seconds. 0 is no wait. */
export const WAIT_CHOICES = [0, 5, 10, 15, 60, 300, 3600, 86400, 172800] as const;

/** What the owner ticked at creation. The wallet address commits to all of it. */
export type WalletPlan = {
  owner: PlanOwner;
  extras: PlanExtra[];
  /** A value from WAIT_CHOICES. Test scripts leave this out, and WAVE_DEMO_DELAY applies. */
  wait?: number;
  sends?: PlanSends;
};

export type WalletPlanResponse = {
  address: Address;
  /** Slot 1 for an owner passkey. Null for a World ID owner. */
  ownerSlot: PasskeySlot | null;
  /** One slot per extra method, in plan order. */
  extraSlots: PasskeySlot[];
};

// POST /api/world/rp-context

export type WorldRpContextRequest = { action: typeof WORLD_ACTION };

/** The field names match the IDKit `rp_context` input. */
export type WorldRpContextResponse = {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
};

// POST /api/world/verify (creation scan)

export type WorldVerifyRequest =
  /** The raw IDKit result. The server calls the Developer Portal verify API. */
  | { source: "idkit"; result: unknown }
  /** A proof from POST /api/world/dev-proof. */
  | { source: "dev"; proof: WorldProof };

export type WorldVerifyResponse = {
  ownerNullifierHash: Hex;
  merkleRoot: Hex;
  /** The counterfactual account address for this owner. */
  address: Address;
  salt: Hex;
};

// POST /api/world/dev-proof

export type WorldDevProofRequest = {
  identity: DevIdentity;
  /** A sig_hash, or CREATE_SIGNAL for the creation scan. */
  signal: string;
};

export type WorldDevProofResponse = WorldProof;

// GET /api/activity?address=0x...

export type ActivityItem = {
  txHash: Hex;
  title: string;
  /** Set for transfers. */
  token: Address | null;
  amount: BaseUnits | null;
  counterparty: Address | null;
  direction: "in" | "out" | "none";
  method: MethodRef | null;
  state: TxState;
  timestamp: UnixSeconds;
};

export type ActivityResponse = {
  items: ActivityItem[];
};

// World ID Agent Pass: POST /api/agent-pass/start, POST /api/agent-pass/device,
// GET /api/agent-pass/status?id=

export const AGENT_PASS_OPERATION = "demo-send-usdc";

/** Why an attempt ended with no approval. The protected action did not get approval. */
export type AgentPassReason =
  | "cancelled"
  | "expired"
  | "identity_mismatch"
  | "unsupported_assurance"
  | "invalid_token"
  | "replayed"
  | "rate_limited"
  | "provider_error";

/** The test panel: a mint of 1 test USDC, in the browser flow. */
export type AgentPassStartRequest = { wallet: Address; operation: typeof AGENT_PASS_OPERATION };

/** An action that an agent asked for. The server already holds its exact content. */
export type AgentPassDeviceRequest = { operationId: string };

/** What a person needs for the device flow. The private device code is never here. */
export type AgentPassDevice = {
  userCode: string;
  verificationUri: string;
  /** The link for the QR code. Null if World gives no such link. */
  verificationUriComplete: string | null;
  /** Unix milliseconds. */
  expiresAt: number;
};

export type AgentPassStartResponse = {
  attemptId: string;
  authorizeUrl: string;
  /** Unix milliseconds. */
  expiresAt: number;
};

export type AgentPassAttempt = {
  id: string;
  status: "pending" | "running" | "approved" | "failed";
  reason: AgentPassReason | null;
  /** Plain text for the person who tests the flow. It never holds a secret. */
  detail: string | null;
  /** Null when a callback matched no attempt. */
  operation: { kind: typeof AGENT_PASS_OPERATION; to: Address; token: Address; amount: BaseUnits } | null;
  /** Unix milliseconds. Zero when a callback matched no attempt. */
  expiresAt: number;
  /** Set when the server sent the transaction. A failed attempt can have one: its outcome is unknown. */
  txHash: Hex | null;
  explorerUrl: string | null;
  acr: string | null;
  amr: string[] | null;
  /** "linked": the first approval for this wallet. "matched": the identity equals the linked one. */
  identity: "linked" | "matched" | null;
};

export type AgentPassStatusResponse = {
  configured: boolean;
  issuer: string;
  sandbox: boolean;
  /** Null with no id, or if the server does not know the id. A restart clears all attempts. */
  attempt: AgentPassAttempt | null;
};

// Agent wallets: GET /api/agents?master=0x..., POST /api/agents/spend, POST /api/agents/checkpoint,
// GET /api/agents/operation?id=, POST /api/agents/decision, POST /api/agents/confirm-token

/** What the server does with a request from an agent. */
export type AgentOperationStatus =
  /** Nothing ran. A human must pass Agent Pass. */
  | "needs-approval"
  /** World ID proved the person. World showed no action, so the person must confirm it in WAVE. */
  | "needs-confirmation"
  /** The approval is used. The server sends the transaction now. */
  | "sending"
  | "done"
  /** The action did not run. */
  | "failed"
  /** The owner said no. The action did not run. */
  | "rejected"
  /** WAVE cannot tell if the transaction ran. The action stays blocked and never sends again. */
  | "unknown"
  | "expired";

export type AgentOperationView = {
  id: string;
  agent: Address;
  status: AgentOperationStatus;
  /** Plain text that the server decodes from the stored operation. */
  decoded: DecodedAction;
  /** Unix milliseconds. */
  expiresAt: number;
  txHash: Hex | null;
  explorerUrl: string | null;
  /** The last reason that an approval did not pass. The operation stays unsent. */
  refusal: { reason: AgentPassReason; detail: string } | null;
  /** The reason that a send failed after the approval. */
  rejection: Rejection | null;
  /** The live device attempt, while it waits for World ID. */
  device: AgentPassDevice | null;
  /** After World ID: "matched" equals the linked owner. "first" is a person that Confirm will link. */
  identity: "matched" | "first" | null;
};

export type AgentView = {
  address: Address;
  balances: TokenBalance[];
  paused: boolean;
  /** The agent key on the chain. Null after a revoke. */
  signer: Address | null;
  /** True if the server holds the key that the chain names. */
  serverHoldsKey: boolean;
  rules: TokenRules[];
  /**
   * Spends above this amount wait for a human. A token with no entry has no rule, so every spend
   * of that token waits. The server enforces this, not the chain.
   */
  askAbove: { token: Address; amount: BaseUnits }[];
  /** True after the first Agent Pass approval links one person to this wallet. */
  identityLinked: boolean;
  sponsor: SponsorView | null;
};

export type AgentsResponse = {
  /** False if this deployment has no agent validator. Deploy the contracts again. */
  supported: boolean;
  /** The address of the agent key on the server. Null if WAVE_AGENT_DEMO_KEY is not set. */
  agentKey: Address | null;
  agentPassConfigured: boolean;
  /** Linked agent wallets of this main wallet, in creation order. */
  agents: AgentView[];
  /** The address and the salt of the next agent wallet. */
  next: { address: Address; salt: Hex } | null;
  /** Newest first. */
  operations: AgentOperationView[];
  /** The agent wallet that the MCP tools use. The "Use with Claude Code" button sets it. */
  toolAgent: Address | null;
};

export type AgentSpendRequest = { agent: Address; token: Address; to: Address; amount: BaseUnits };

export type AgentSpendResponse =
  | { result: "sent"; txHash: Hex; explorerUrl: string; frames: FrameView[] }
  | { result: "needs-approval"; operation: AgentOperationView }
  | { result: "rejected"; rejection: Rejection };

/** The answer of a person on the /agents page. Only Confirm sends, so only Confirm needs the token. */
export type AgentDecisionRequest =
  | { operationId: string; decision: "confirm"; confirmToken: string }
  | { operationId: string; decision: "reject" };

/** The page asks for this after a click on Confirm. The token works once, for one operation. */
export type AgentConfirmTokenRequest = { operationId: string };

export type AgentConfirmTokenResponse = { confirmToken: string };

export type AgentCheckpointRequest = { agent: Address; token: Address; askAbove: BaseUnits };

export type AgentCheckpointResponse =
  | { result: "applied" }
  /** A higher amount gives the agent more freedom, so a human must approve it. */
  | { result: "needs-approval"; operation: AgentOperationView };

// The local MCP server for Claude Code: GET and POST /api/mcp/agent, POST /api/mcp/send.
// It reads an operation with GET /api/agents/operation. No route here can approve a payment.

export type ToolAgentRequest = { agent: Address };

export type ToolAgentState = "active" | "paused" | "revoked" | "wrong-key";

/** All amounts are plain token amounts, such as "12.5". */
export type ToolTokenView = {
  symbol: string;
  isTest: boolean;
  balance: string;
  /** The most that one payment can send onchain. Null means that no onchain rule lets the agent spend. */
  perTransfer: string | null;
  /** The hard total. Null means that no total applies. */
  perDay: string | null;
  /** What the total still allows. Null means that no total applies. */
  leftToday: string | null;
  /** The agent sends alone up to this amount, which the chain allows. Null means that a human approves each payment. */
  askAbove: string | null;
};

export type ToolAgentResponse = {
  agent: Address;
  state: ToolAgentState;
  tokens: ToolTokenView[];
};

export type ToolSendRequest = {
  to: string;
  /** A plain amount, such as "12.5". */
  amount: string;
  /** A symbol. The default is tUSDC. */
  token?: string;
  /** The same text means the same payment, so a retry cannot pay twice. */
  clientRef?: string;
};

export type ToolSendResponse = {
  /** The caller's text, or a new one from the server. A retry must pass it again. */
  clientRef: string;
  /** Plain text, such as "1 tUSDC to 0x...". */
  payment: string;
  /** True if an earlier call with this clientRef did the work. Nothing new ran. */
  repeat: boolean;
} & (
  | {
      result: "sent";
      txHash: Hex;
      explorerUrl: string;
      /** False if the mempool took it, and WAVE has no receipt yet. */
      confirmed: boolean;
    }
  | {
      result: "needs_approval";
      operationId: string;
      action: DecodedAction;
      /** Unix milliseconds. */
      expiresAt: number;
      /** "world-id": the owner must log in. "confirm": the owner must press Confirm. */
      step: "world-id" | "confirm";
      /** The code and the link. Null if a new attempt must start on the /agents page. */
      device: AgentPassDevice | null;
      /** Why no code is here, in plain text. */
      note: string | null;
    }
  | { result: "refused"; reason: string }
  /** WAVE cannot tell if this ran. It stays blocked and never sends again. */
  | { result: "unknown"; reason: string; txHash: Hex | null; explorerUrl: string | null }
);
