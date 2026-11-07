// A Claude Code Stop hook. The WAVE MCP server notes a payment that waits for a human in
// .wave/mcp-waiting.json. This script then reads its state each second, and it hands the result
// back to Claude when the payment ends, so the owner does not need to say "done".
// It only reads. It cannot approve, confirm or send anything.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const NOTE = path.join(ROOT, ".wave/mcp-waiting.json");
const BASE_URL = process.env.WAVE_URL ?? "http://localhost:3000";
const EVERY_MS = 1000;
// Below the hook timeout in .claude/settings.local.json.
const MAX_MS = 175_000;
const RUNNING = new Set(["needs-approval", "needs-confirmation", "sending"]);

function readNote() {
  try {
    return JSON.parse(readFileSync(NOTE, "utf8")).operationId ?? null;
  } catch {
    return null;
  }
}

const clearNote = () => rmSync(NOTE, { force: true });

async function readOperation(id) {
  const response = await fetch(`${BASE_URL}/api/agents/operation?id=${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.ok ? response.json() : null;
}

function result(view) {
  const title = view.decoded?.title ?? "The payment";
  const proof = view.txHash ? ` Transaction: ${view.txHash}.${view.explorerUrl ? ` Explorer: ${view.explorerUrl}` : ""}` : "";
  switch (view.status) {
    case "done":
      return `${title} is sent.${proof}`;
    case "rejected":
      return `${title} was rejected by the owner. Nothing was sent.`;
    case "expired":
      return `${title} expired before the owner finished. Nothing was sent.`;
    case "unknown":
      return `WAVE cannot tell if "${title}" ran. It will not send it again. Check the wallet activity.${proof}`;
    case "failed":
      return `${title} did not run.${proof}`;
    default:
      return `${title} still waits for the owner, at the step ${view.status}. The watcher stopped.`;
  }
}

function report(text) {
  // "block" keeps Claude working, so it can tell the owner this result.
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: `The approval watcher reports: ${text} Tell the owner this in one short message. Do not start a new payment.` }),
  );
}

const id = readNote();
if (id) {
  const stopAt = Date.now() + MAX_MS;
  let view = null;
  for (;;) {
    view = await readOperation(id).catch(() => null);
    if (!view || !RUNNING.has(view.status) || readNote() !== id || Date.now() >= stopAt) break;
    await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
  }
  // A newer payment took over the note, so that payment stays for the next run.
  if (readNote() === id) clearNote();
  if (view) report(result(view));
}
