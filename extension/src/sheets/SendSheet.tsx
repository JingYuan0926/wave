import { useState } from "react";
import { ExternalLink, Info, TriangleAlert } from "lucide-react";
import { isAddress, type Address } from "viem";
import { METHOD_LABEL, TOKEN_ORDER, type MethodId, type Token } from "../data";
import { fmtToken, shortAddr } from "../lib/format";
import { NETWORK_NAME, tokenInfo, txUrl } from "../lib/wc/config";
import { selectTier, sendNow, sendScheduled, toUnits, type SendResult } from "../lib/wc/wallet";
import { useStore } from "../store";
import { Avatar, METHOD_ICON, PrimaryButton, Sheet, TokenIcon, focusRing } from "../components/ui";
import { ApprovingView, DoneView } from "../components/Approving";

type Step = "form" | "review" | "approving" | "done" | "error";

const HOUR = 3600;

export function SendSheet({ onClose, recipientId }: { onClose: () => void; recipientId?: string }) {
  const { state, addTx, refresh } = useStore();
  const main = state.wallet;
  const [step, setStep] = useState<Step>("form");
  const [rid, setRid] = useState(recipientId ?? state.recipients[0]?.id ?? "address");
  const [typed, setTyped] = useState("");
  const [token, setToken] = useState<Token>(TOKEN_ORDER.find((t) => main.balances[t] > 0) ?? "USDT");
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState("");

  const saved = state.recipients.find((r) => r.id === rid);
  const toAddress = (saved?.address ?? typed.trim()) as Address;
  const toName = saved?.name ?? shortAddr(toAddress);
  const validTo = isAddress(toAddress) && toAddress.toLowerCase() !== main.address.toLowerCase();

  const info = tokenInfo(token);
  const amount = Number.parseFloat(raw) || 0;
  const units = info ? toUnits(amount, info.decimals) : 0n;
  const balance = main.balances[token];
  const overBalance = amount > balance;
  const choice = state.tiers[token] ? selectTier(state.tiers[token]!, units) : null;
  const delayS = choice?.tier.delay ?? 0;
  const delayH = Math.round(delayS / HOUR);
  const method: MethodId = "faceid";
  const MethodIcon = METHOD_ICON[method];
  const canContinue = !!info && validTo && amount > 0 && !overBalance && !!choice;

  const approve = async () => {
    if (!info || !state.passkey) return;
    setStep("approving");
    try {
      const r = delayS > 0
        ? await sendScheduled(state.passkey, info, toAddress, units)
        : await sendNow(state.passkey, info, toAddress, units);
      if (!r.success) throw new Error("The transaction ran, but the wallet's rules refused this transfer. No money moved.");
      setResult(r);
      if (delayS === 0) {
        addTx({ kind: "out", title: `To ${toName}`, subtitle: "Passkey · Just now", amount, token, method, href: r.explorerUrl });
      }
      setStep("done");
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/NotAllowedError|aborted|cancel/i.test(msg) ? "The passkey prompt was closed. Nothing was sent." : msg);
      setStep("error");
    }
  };

  const title = { form: "Send money", review: "Check and approve", approving: "Approving", done: "", error: "Not sent" }[step];

  return (
    <Sheet title={title || (delayS > 0 ? "Scheduled" : "Sent")} onClose={onClose}>
      {step === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canContinue) setStep("review");
          }}
        >
          <fieldset>
            <legend className="text-[15px] font-medium text-ink-2">To</legend>
            <div className="no-scrollbar -mx-5 mt-3 flex gap-3 overflow-x-auto px-5 pb-1">
              {state.recipients.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={r.id === rid}
                  onClick={() => setRid(r.id)}
                  className={`flex w-[72px] shrink-0 flex-col items-center gap-1.5 rounded-2xl p-1.5 ${focusRing}`}
                >
                  <span className={`rounded-full p-0.5 ring-2 transition ${r.id === rid ? "ring-wave-deep" : "ring-transparent"}`}>
                    <Avatar name={r.name} />
                  </span>
                  <span className={`w-full truncate text-center text-xs ${r.id === rid ? "font-bold" : "text-ink-2"}`}>
                    {r.name.split(" ")[0]}
                  </span>
                </button>
              ))}
              <button
                type="button"
                aria-pressed={rid === "address"}
                onClick={() => setRid("address")}
                className={`flex w-[72px] shrink-0 flex-col items-center gap-1.5 rounded-2xl p-1.5 ${focusRing}`}
              >
                <span className={`rounded-full p-0.5 ring-2 transition ${rid === "address" ? "ring-wave-deep" : "ring-transparent"}`}>
                  <span className="grid size-12 place-items-center rounded-full bg-surface-2 font-mono text-sm font-bold" aria-hidden>
                    0x
                  </span>
                </span>
                <span className={`w-full truncate text-center text-xs ${rid === "address" ? "font-bold" : "text-ink-2"}`}>Address</span>
              </button>
            </div>
            {rid === "address" && (
              <div className="mt-2">
                <label htmlFor="send-to" className="sr-only">
                  Recipient address
                </label>
                <input
                  id="send-to"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-invalid={typed.length > 0 && !validTo}
                  className="h-12 w-full rounded-2xl bg-surface px-4 font-mono text-sm outline-none ring-wave-deep focus-visible:ring-2"
                />
                {typed.length > 0 && !validTo && (
                  <p className="mt-1.5 text-sm font-semibold text-danger">Enter a 0x address of 42 characters (not this wallet).</p>
                )}
              </div>
            )}
          </fieldset>

          <div className="mt-5 rounded-[24px] bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="send-amount" className="text-[15px] font-medium text-ink-2">
                Amount
              </label>
              <div className="inline-flex rounded-full bg-white p-1 ring-1 ring-line" role="group" aria-label="Token">
                {TOKEN_ORDER.map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={token === t}
                    onClick={() => setToken(t)}
                    className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full pl-1 pr-2.5 text-sm font-semibold ${token === t ? "bg-ink text-white" : "text-ink-2"} ${focusRing}`}
                  >
                    <TokenIcon token={t} size="sm" />
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <input
              id="send-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={raw}
              data-autofocus
              aria-invalid={overBalance}
              aria-describedby="amount-help"
              onChange={(e) => {
                const v = e.target.value.replace(",", ".");
                if (/^\d*\.?\d{0,6}$/.test(v)) setRaw(v);
              }}
              className="mt-2 w-full bg-transparent text-[2.5rem] font-bold tabular-nums tracking-tight outline-none placeholder:text-[#b3b3b3]"
            />
            <p id="amount-help" className={`text-sm ${overBalance ? "font-semibold text-danger" : "text-muted"}`}>
              {overBalance ? `More than your balance of ${fmtToken(balance, token)}` : `Balance: ${fmtToken(balance, token)}`}
            </p>
          </div>

          {amount > 0 && !overBalance && (
            <div className="mt-3 flex gap-3 rounded-[20px] bg-wave-mist p-4" aria-live="polite">
              <MethodIcon className="mt-0.5 size-5 shrink-0 text-wave-deep" aria-hidden />
              <p className="text-sm leading-snug text-ink-2">
                {choice ? (
                  <>
                    Your <span className="font-semibold text-ink">passkey</span> approves this amount.{" "}
                    {delayS > 0 ? `It runs after ${delayH} hours, and you can cancel it.` : "It runs at once."}
                    {choice.capSkipped && " Your cap for smaller amounts is used up, so the next tier applies."}
                  </>
                ) : (
                  "No spending rule allows this amount right now."
                )}
              </p>
            </div>
          )}

          <div className="mt-5">
            <PrimaryButton type="submit" disabled={!canContinue}>
              Continue
            </PrimaryButton>
          </div>
        </form>
      )}

      {step === "review" && (
        <div>
          <div className="flex items-center gap-3">
            <Avatar name={saved?.name ?? "0 x"} size="lg" />
            <div>
              <p className="text-sm text-muted">You send</p>
              <p className="text-3xl font-bold tabular-nums tracking-tight">{fmtToken(amount, token)}</p>
            </div>
          </div>

          <dl className="mt-5 divide-y divide-line rounded-[24px] bg-surface px-4">
            {(
              [
                ...(saved ? ([["To", saved.name]] as const) : []),
                ["Address", shortAddr(toAddress)],
                ["Network", NETWORK_NAME],
                ["Approves with", METHOD_LABEL[method]],
                ["Timing", delayS > 0 ? `After ${delayH}h · cancellable` : "At once"],
                ["Gas", "Paid by WAVE"],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-3">
                <dt className="text-[15px] text-muted">{k}</dt>
                <dd className="text-right text-[15px] font-semibold">{v}</dd>
              </div>
            ))}
          </dl>

          {!state.deployed && (
            <div className="mt-3 flex gap-3 rounded-[20px] bg-wave-mist p-4">
              <Info className="mt-0.5 size-5 shrink-0 text-wave-deep" aria-hidden />
              <p className="text-sm leading-snug text-ink-2">This is your wallet's first transaction, so it also sets up the wallet onchain.</p>
            </div>
          )}

          <div className="mt-5 space-y-2">
            <PrimaryButton onClick={approve}>
              <MethodIcon className="size-5" aria-hidden />
              Approve with {METHOD_LABEL[method]}
            </PrimaryButton>
            <PrimaryButton tone="ghost" onClick={() => setStep("form")}>
              Edit
            </PrimaryButton>
          </div>
        </div>
      )}

      {step === "approving" && <ApprovingView method={method} />}

      {step === "done" && result && (
        <>
          <DoneView
            title={delayS > 0 ? "Transfer scheduled" : `${fmtToken(amount, token)} sent`}
            body={delayS > 0 ? `It runs in ${delayH} hours. You can cancel it from Payments until then.` : `${toName} has the money now.`}
            onDone={onClose}
          />
          <a
            href={txUrl(result.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-3 flex h-11 items-center justify-center gap-2 rounded-full text-[15px] font-semibold text-ink-2 hover:bg-surface ${focusRing}`}
          >
            View on Whitechain explorer <ExternalLink className="size-4" aria-hidden />
          </a>
        </>
      )}

      {step === "error" && (
        <div>
          <div className="flex gap-3 rounded-[20px] bg-danger-soft p-4" role="alert">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <p className="text-sm leading-snug text-ink">{error}</p>
          </div>
          <div className="mt-5 space-y-2">
            <PrimaryButton onClick={() => setStep("review")}>Try again</PrimaryButton>
            <PrimaryButton tone="ghost" onClick={onClose}>
              Close
            </PrimaryButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}
