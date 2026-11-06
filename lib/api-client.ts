import {
  AGENT_PASS_OPERATION,
  API_ROUTES,
  type AccountResponse,
  type ActivityResponse,
  type Address,
  type AgentCheckpointRequest,
  type AgentCheckpointResponse,
  type AgentSpendRequest,
  type AgentSpendResponse,
  type AgentsResponse,
  type AgentPassStartResponse,
  type AgentPassStatusResponse,
  type ApiErrorBody,
  type DevIdentity,
  type FaucetResponse,
  type Hex,
  type InfoResponse,
  type RootPublishResponse,
  type TxPrepareRequest,
  type TxPrepareResponse,
  type TxSendRequest,
  type TxSendResponse,
  type TxStatusResponse,
  type WorldDevProofResponse,
  type WorldRpContextResponse,
  type WorldVerifyRequest,
  type WorldVerifyResponse,
  WORLD_ACTION,
} from "./api-types";

/** Set for all failures of a route call. A rule rejection is not an ApiError. */
export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** The server or the chain cannot be reached. The UI shows the offline banner. */
export function isOffline(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "OFFLINE" || error.code === "CHAIN_OFFLINE")
  );
}

async function realRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("OFFLINE", "The WAVE server does not answer.");
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      "BAD_RESPONSE",
      `${path} returned status ${response.status} with no JSON.`,
      response.status,
    );
  }

  if (!response.ok) {
    const error = (parsed as Partial<ApiErrorBody>).error;
    throw new ApiError(
      error?.code ?? "SERVER_ERROR",
      error?.message ?? `${path} failed with status ${response.status}.`,
      response.status,
    );
  }
  return parsed as T;
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  // The build replaces this variable. In a normal build the branch is dead
  // code, so the mock module is not in the bundle.
  if (process.env.NEXT_PUBLIC_WAVE_MOCK === "1") {
    const { mockRequest } = await import("./mock/handler");
    return mockRequest<T>(method, path, body);
  }
  return realRequest<T>(method, path, body);
}

function withQuery(path: string, key: string, value: string): string {
  return `${path}?${key}=${encodeURIComponent(value)}`;
}

export const api = {
  info: () => request<InfoResponse>("GET", API_ROUTES.info),

  account: (address: Address) =>
    request<AccountResponse>("GET", withQuery(API_ROUTES.account, "address", address)),

  activity: (address: Address) =>
    request<ActivityResponse>("GET", withQuery(API_ROUTES.activity, "address", address)),

  faucet: (address: Address) =>
    request<FaucetResponse>("POST", API_ROUTES.faucet, { address }),

  rootPublish: (root?: Hex) =>
    request<RootPublishResponse>("POST", API_ROUTES.rootPublish, { root }),

  txPrepare: (body: TxPrepareRequest) =>
    request<TxPrepareResponse>("POST", API_ROUTES.txPrepare, body),

  txSend: (body: TxSendRequest) =>
    request<TxSendResponse>("POST", API_ROUTES.txSend, body),

  txStatus: (hash: Hex) =>
    request<TxStatusResponse>("GET", withQuery(API_ROUTES.txStatus, "hash", hash)),

  worldRpContext: () =>
    request<WorldRpContextResponse>("POST", API_ROUTES.worldRpContext, {
      action: WORLD_ACTION,
    }),

  worldVerify: (body: WorldVerifyRequest) =>
    request<WorldVerifyResponse>("POST", API_ROUTES.worldVerify, body),

  worldDevProof: (identity: DevIdentity, signal: string) =>
    request<WorldDevProofResponse>("POST", API_ROUTES.worldDevProof, {
      identity,
      signal,
    }),

  // These skip the mock on purpose: Agent Pass has no mock approval.
  agents: (master: Address) =>
    realRequest<AgentsResponse>("GET", withQuery(API_ROUTES.agents, "master", master)),

  agentSpend: (body: AgentSpendRequest) =>
    realRequest<AgentSpendResponse>("POST", API_ROUTES.agentSpend, body),

  agentCheckpoint: (body: AgentCheckpointRequest) =>
    realRequest<AgentCheckpointResponse>("POST", API_ROUTES.agentCheckpoint, body),

  agentPassApprove: (operationId: string) =>
    realRequest<AgentPassStartResponse>("POST", API_ROUTES.agentPassStart, { operationId }),

  agentPassStart: (wallet: Address) =>
    realRequest<AgentPassStartResponse>("POST", API_ROUTES.agentPassStart, {
      wallet,
      operation: AGENT_PASS_OPERATION,
    }),

  agentPassStatus: (id: string | null) =>
    realRequest<AgentPassStatusResponse>(
      "GET",
      id ? withQuery(API_ROUTES.agentPassStatus, "id", id) : API_ROUTES.agentPassStatus,
    ),
};

export function explorerTxUrl(info: InfoResponse, hash: Hex): string {
  return `${info.explorerUrl}/tx/${hash}?node=${encodeURIComponent(info.rpcUrl)}`;
}
