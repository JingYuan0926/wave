import { useState } from "react";
import { Info } from "lucide-react";
import { METHOD_LABEL, tierFor, type MethodId, type Token } from "../data";
import { fmtToken, shortAddr } from "../lib/format";
import { requestApproval } from "../lib/approvals";
import { useStore } from "../store";
import { Avatar, METHOD_ICON, PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ApprovingView, DoneView } from "../components/Approving";

type Step = "form" | "review" | "approving" | "done";

export function SendSheet({ onClose, recipientId }: { onClose: () => void; recipientId?: string }) {
  const { state, addTx, addPending, debit } = useStore();
  const main = state.wallet;
  const [step, setStep] = useState<Step>("form");
  const [rid, setRid] = useState(recipientId ?? state.recipients[0]?.id);
  const [token, setToken] = useState<Token>("USDC");
  const [raw, setRaw] = useState("");

  const recipient = state.recipients.find((r) => r.id === rid);
  const amount = Number.parseFloat(raw) || 0;
  const balance = main.balances[token];
  const overBalance = amount > balance;
  const { tier, capSkipped } = tierFor(token, amount);
  const method: MethodId = tier.method;
  const canContinue = !!recipient && amount > 0 && !overBalance;
  const MethodIcon = METHOD_ICON[method];

  const approve = async () => {
    if (!recipient) return;
    setStep("approving");
    await requestApproval(method);
    if (tier.delayHours > 0) {
      addPending({
        title: `Send ${fmtToken(amount, token)}`,
        detail: `To ${recipient.name}`,
        proposedBy: method,
        endsAt: Date.now() + tier.delayHours * 3_600_000,
        cancelBy: ["worldid", "faceid"],
        transfer: { token, amount, to: recipient.name },
      });
    } else {
      debit(token, amount);
      addTx({
        kind: "out",
        title: `To ${recipient.name}`,
        subtitle: `${METHOD_LABEL[method]} · Just now`,
        amount,
        token,
        method,
      });
    }
    setStep("done");
  };

  const title = { form: "Send money", review: "Check and approve", approving: "Approving", done: "" }[step];

  return (
    <Sheet title={title || (tier.delayHours > 0 ? "Scheduled" : "Sent")} onClose={onClose}>
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
            </div>
          </fieldset>

          <div className="mt-5 rounded-[24px] bg-surface p-4">
            <div className="flex items-center justify-between">
              <label htmlFor="send-amount" className="text-[15px] font-medium text-ink-2">
                Amount
              </label>
              <div className="inline-flex rounded-full bg-white p-1 ring-1 ring-line" role="group" aria-label="Token">
                {(["USDC", "ETH"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={token === t}
                    onClick={() => setToken(t)}
                    className={`h-8 rounded-full px-3 text-sm font-semibold ${token === t ? "bg-ink text-white" : "text-ink-2"} ${focusRing}`}
                  >
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
              className="mt-2 w-full bg-transparent text-[2.5rem] font-bold tabular-nums tracking-tight outline-none placeholder:text-[#b5bccb]"
            />
            <p id="amount-help" className={`text-sm ${overBalance ? "font-semibold text-danger" : "text-muted"}`}>
              {overBalance ? `More than your balance of ${fmtToken(balance, token)}` : `Balance: ${fmtToken(balance, token)}`}
            </p>
          </div>

          {amount > 0 && !overBalance && (
            <div className="mt-3 flex gap-3 rounded-[20px] bg-wave-mist p-4" aria-live="polite">
              <MethodIcon className="mt-0.5 size-5 shrink-0 text-wave-deep" aria-hidden />
              <p className="text-sm leading-snug text-ink-2">
                <span className="font-semibold text-ink">{METHOD_LABEL[method]}</span> approves this amount.{" "}
                {tier.delayHours > 0 ? `It runs after ${tier.delayHours} hours, and you can cancel it.` : "It runs at once."}
                {capSkipped && " Your cap for smaller amounts is used up, so the next tier applies."}
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

      {step === "review" && recipient && (
        <div>
          <div className="flex items-center gap-3">
            <Avatar name={recipient.name} size="lg" />
            <div>
              <p className="text-sm text-muted">You send</p>
              <p className="text-3xl font-bold tabular-nums tracking-tight">{fmtToken(amount, token)}</p>
            </div>
          </div>

          <dl className="mt-5 divide-y divide-line rounded-[24px] bg-surface px-4">
            {(
              [
                ["To", `${recipient.name}`],
                ["Address", recipient.handle ?? shortAddr(recipient.address)],
                ["Network", "WAVE devnet"],
                ["Approves with", METHOD_LABEL[method]],
                ["Timing", tier.delayHours > 0 ? `After ${tier.delayHours}h · cancellable` : "At once"],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-3">
                <dt className="text-[15px] text-muted">{k}</dt>
                <dd className="text-right text-[15px] font-semibold">{v}</dd>
              </div>
            ))}
          </dl>

          {method === "worldid" && (
            <div className="mt-3 flex gap-3 rounded-[20px] bg-warn-soft p-4">
              <Info className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
              <p className="text-sm leading-snug text-ink-2">
                World App won't show these details. Check them here before you approve.
              </p>
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

      {step === "done" && recipient && (
        <DoneView
          title={tier.delayHours > 0 ? "Transfer scheduled" : `${fmtToken(amount, token)} sent`}
          body={
            tier.delayHours > 0
              ? `It runs in ${tier.delayHours} hours. You can cancel it from Payments until then.`
              : `${recipient.name} has the money now.`
          }
          onDone={onClose}
        />
      )}
    </Sheet>
  );
}
