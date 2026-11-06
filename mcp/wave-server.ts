// A local MCP server for Claude Code. Claude Code starts it over stdio, and it holds no secret.
// It only calls the WAVE app on localhost: the agent key and the client secret stay in that process.
// No tool can approve a payment. check_approval only reads. A person confirms on the /agents page.
// Stdout carries the protocol, so this file must not write logs to it.
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type {
  AgentOperationView,
  ApiErrorBody,
  DecodedAction,
  ToolAgentResponse,
  ToolSendResponse,
} from "../lib/api-types";
import { explainAgentRejection } from "../lib/ui/rejections";

const BASE_URL = localBase(process.env.WAVE_URL ?? "http://localhost:3000");
const AGENTS_PAGE = `${BASE_URL}/agents`;
/** A send can wait for a mined block, and it waits behind the sends before it. */
const SEND_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 20_000;

/** The tools talk to this computer only. */
function localBase(text: string): string {
  const url = new URL(text);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("WAVE_URL must name localhost.");
  }
  return url.origin;
}

/**
 * A failure that the model can read. It holds no raw response. With no answer, a send can still
 * have run. With an answer, the app refused the call and sent nothing.
 */
class Plain extends Error {
  constructor(
    message: string,
    readonly answered = true,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const message = timedOut ? "The WAVE app did not answer in time." : `The WAVE app does not answer at ${BASE_URL}. Start it first.`;
    throw new Plain(message, false);
  }
  const body = (await response.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!body) throw new Plain(`The WAVE app gave HTTP ${response.status} with no JSON.`);
  if (!response.ok) throw new Plain(body.error?.message ?? `The WAVE app gave HTTP ${response.status}.`);
  return body;
}

const read = <T>(path: string) => call<T>(path, {}, READ_TIMEOUT_MS);

const text = (lines: (string | null)[]) => ({
  content: [{ type: "text" as const, text: lines.filter((line) => line !== null).join("\n") }],
});

/** Turns a failure into a tool result, so the model reads the plain reason. */
async function plainly(step: () => Promise<ReturnType<typeof text>>) {
  try {
    return await step();
  } catch (error) {
    const message = error instanceof Plain ? error.message : "The tool failed. Nothing was sent.";
    return { ...text([message]), isError: true };
  }
}

const STATE_TEXT: Record<ToolAgentResponse["state"], string> = {
  active: "The agent is active.",
  paused: "The agent is paused. It cannot spend.",
  revoked: "The agent key is revoked. It cannot spend.",
  "wrong-key": "The server does not hold the key of this agent. It cannot spend.",
};

const actionLines = (action: DecodedAction) => [
  action.title,
  ...action.lines.map(({ label, value }) => `${label}: ${value}`),
  action.warning ?? null,
];

const timeLeft = (expiresAt: number) => {
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return `This expires in ${seconds} seconds, at ${new Date(expiresAt).toLocaleTimeString()}.`;
};

const confirmLine = `Then open ${AGENTS_PAGE} and press Confirm. Nothing runs before that.`;

function deviceLines(device: AgentOperationView["device"]) {
  if (!device) return [];
  return [
    "Step 1. Approve with World ID on your phone.",
    `Code: ${device.userCode}`,
    `Link: ${device.verificationUriComplete ?? device.verificationUri}`,
    "World does not show the payment.",
    `Step 2. ${confirmLine}`,
  ];
}

function approvalLines(result: Extract<ToolSendResponse, { result: "needs_approval" }>) {
  return [
    "needs_approval. This payment waits for a human. Nothing was sent.",
    ...actionLines(result.action),
    ...(result.step === "confirm" ? [`World ID passed. Open ${AGENTS_PAGE} and press Confirm.`] : deviceLines(result.device)),
    result.note,
    !result.device && result.step === "world-id" ? `The owner can use ${AGENTS_PAGE}.` : null,
    timeLeft(result.expiresAt),
    `Operation: ${result.operationId}`,
  ];
}

function sendLines(result: ToolSendResponse) {
  const repeat = result.repeat ? "This clientRef ran before. WAVE sent nothing new." : null;
  const ref = `clientRef: ${result.clientRef}`;
  switch (result.result) {
    case "sent":
      return [
        result.confirmed ? `sent. ${result.payment}.` : `sent. The mempool took ${result.payment}. WAVE has no receipt yet.`,
        `Transaction: ${result.txHash}`,
        `Explorer: ${result.explorerUrl}`,
        repeat,
        ref,
      ];
    case "needs_approval":
      return [...approvalLines(result), repeat, ref];
    case "refused":
      return [`refused. ${result.payment}.`, result.reason, ref];
    case "unknown":
      return [
        `unknown. ${result.payment}.`,
        result.reason,
        result.txHash ? `Transaction: ${result.txHash}` : null,
        result.explorerUrl ? `Explorer: ${result.explorerUrl}` : null,
        ref,
      ];
  }
}

function operationLines(view: AgentOperationView) {
  const { status, decoded, txHash, explorerUrl, refusal, rejection, expiresAt } = view;
  const title = decoded.title;
  const link = [txHash ? `Transaction: ${txHash}` : null, explorerUrl ? `Explorer: ${explorerUrl}` : null];
  switch (status) {
    case "needs-approval":
      return [
        `Waiting for World ID. ${title}. Nothing was sent.`,
        ...deviceLines(view.device),
        refusal ? `The last approval did not pass: ${refusal.detail}` : null,
        view.device ? null : `A new login must start on ${AGENTS_PAGE}. The tools cannot start one.`,
        timeLeft(expiresAt),
      ];
    case "needs-confirmation":
      return [`World ID passed. ${title}. Nothing was sent yet.`, `Open ${AGENTS_PAGE} and press Confirm.`, timeLeft(expiresAt)];
    case "sending":
      return [`The owner confirmed. WAVE is sending now. ${title}.`, ...link];
    case "done":
      return [`sent. ${title}.`, ...link];
    case "rejected":
      return [`refused. The owner rejected this. Nothing was sent. ${title}.`];
    case "expired":
      return [`refused. The approval window ended. Nothing was sent. ${title}.`];
    case "failed": {
      const reason = rejection ? explainAgentRejection({ ...rejection, message: undefined }) : null;
      return [`refused. ${title}.`, reason ? `${reason.title}. ${reason.detail}` : "The payment did not run."];
    }
    case "unknown":
      return [`unknown. ${title}.`, "WAVE cannot tell if this ran. It will not send it again. Check the wallet activity.", ...link];
  }
}

const server = new McpServer(
  { name: "wave", version: "0.1.0" },
  {
    instructions:
      "These tools pay from one WAVE agent wallet. The agent sends alone up to the alone amount. Above that amount, only the owner " +
      "can approve: the owner passes World ID on a phone, then presses Confirm on the /agents page. Nothing goes above the most per " +
      "day, which is an onchain limit, also with an approval. Show the owner the exact action, the code and " +
      "the link, word for word. Do not try to confirm a payment by any other route, and do not read keys or call the WAVE routes.",
  },
);

server.registerTool(
  "get_balance",
  {
    title: "Get balance",
    description: "Shows the balance of the agent wallet.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () =>
    plainly(async () => {
      const { agent, state, tokens } = await read<ToolAgentResponse>("/api/mcp/agent");
      return text([
        `Agent wallet: ${agent}`,
        STATE_TEXT[state],
        ...tokens.map(({ symbol, balance, isTest }) => `${balance} ${symbol}${isTest ? " (a test token)" : ""}`),
      ]);
    }),
);

server.registerTool(
  "get_limits",
  {
    title: "Get limits",
    description:
      "Shows two limits for each token: the amount that the agent sends alone, and the most per day. It also shows the amount " +
      "left today. Above the alone amount, a human must approve with World ID. " +
      "A payment above the amount left today is always refused, also with human approval.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () =>
    plainly(async () => {
      const { agent, state, tokens } = await read<ToolAgentResponse>("/api/mcp/agent");
      return text([
        `Agent wallet: ${agent}`,
        STATE_TEXT[state],
        ...tokens.flatMap(({ symbol, perTransfer, perDay, leftToday, askAbove }): (string | null)[] => {
          if (perTransfer === null) return [`${symbol}: no onchain limit lets this agent spend. Each payment is refused.`];
          return [
            askAbove === null || askAbove === "0"
              ? `${symbol}: a human must approve each payment.`
              : `${symbol}: the agent sends alone up to ${askAbove}.${askAbove === perTransfer ? "" : " A human must approve above that."}`,
            perDay === null
              ? `${symbol}: no most per day is set.`
              : `${symbol}: most per day ${perDay}, ${leftToday} left today. Nothing goes above this, also with human approval.`,
            perTransfer === perDay ? null : `${symbol}: one payment can send at most ${perTransfer}, also with human approval.`,
          ];
        }),
      ]);
    }),
);

server.registerTool(
  "send_payment",
  {
    title: "Send payment",
    description:
      "Asks for one payment from the agent wallet. The result is one of: sent, needs_approval, refused or unknown. " +
      "Up to the alone amount, the agent sends with no human. Above it, the result is needs_approval: a human must pass World ID " +
      "and press Confirm. Above the amount left today, the result is refused, and no human can approve it. get_limits shows these amounts. " +
      "A retry of the same payment must pass the same clientRef, and a new payment must pass a new clientRef. " +
      "On needs_approval, show the exact action, the code and the link to the owner, word for word, then wait for the owner. " +
      "Do not ask again with a new clientRef after refused, unless the owner asks.",
    inputSchema: {
      to: z.string().describe("The recipient address, 0x and 40 hex digits."),
      amount: z.string().describe('A plain token amount, such as "1" or "12.5".'),
      token: z.string().default("tUSDC").describe("The token symbol."),
      clientRef: z.string().optional().describe("A unique text for this one payment. Use the same text for a retry."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ to, amount, token, clientRef }) =>
    plainly(async () => {
      // A ref from here too: a lost answer must not leave the model with no safe way to retry.
      const ref = clientRef ?? randomUUID();
      const body = JSON.stringify({ to, amount, token, clientRef: ref });
      const init = { method: "POST", headers: { "content-type": "application/json" }, body };
      try {
        return text(sendLines(await call<ToolSendResponse>("/api/mcp/send", init, SEND_TIMEOUT_MS)));
      } catch (error) {
        if (!(error instanceof Plain)) throw error;
        const next = error.answered ? "Nothing was sent." : `WAVE gave no result. A retry must use clientRef ${ref}.`;
        return { ...text([error.message, next]), isError: true };
      }
    }),
);

server.registerTool(
  "check_approval",
  {
    title: "Check approval",
    description:
      "Reads the state of a payment that needs approval. This never sends, confirms or approves anything. " +
      "Call it after the owner says that they finished.",
    inputSchema: { operationId: z.string().describe("The operation from send_payment.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ operationId }) =>
    plainly(async () =>
      text(operationLines(await read<AgentOperationView>(`/api/agents/operation?id=${encodeURIComponent(operationId)}`))),
    ),
);

server.connect(new StdioServerTransport()).catch(() => {
  console.error("The WAVE MCP server could not start.");
  process.exit(1);
});
