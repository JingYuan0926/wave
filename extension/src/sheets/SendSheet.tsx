import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { Token } from "../data";
import { fmtToken, shortAddr } from "../lib/format";
import {
  formatDuration,
  leftToday,
  parseTokenAmount,
  plainAmount,
  recipientProblem,
  testToken,
  tokenBalance,
  type Address,
  type TxAction,
} from "../lib/wave";
import { useSpendCheck, useStore, useWaveApproval } from "../store";
import { PrimaryButton, Sheet, TokenIcon, focusRing } from "../components/ui";
import { ApproveButtons, ApprovingView } from "../components/Approving";
import { useWhitechainPayments } from "../lib/wc/switch";
import { WhitechainSendSheet } from "./WhitechainSendSheet";

type Step = "form" | "review";

export function Stop({ children }: { children: string }) {
  return (
    <div className="mt-3 flex gap-3 rounded-[20px] bg-danger-soft p-4" role="alert">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
      <p className="text-sm leading-snug text-ink">{children}</p>
    </div>
  );
}

/** The rows of a review step. */
export function ReviewRows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="mt-5 divide-y divide-line rounded-[24px] bg-surface px-4">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-3">
          <dt className="shrink-0 text-[15px] text-muted">{k}</dt>
          <dd className="text-right text-[15px] font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type SendSheetProps = { onClose: () => void; recipientId?: string };

/** The Whitechain switch picks the sheet here, so the normal send below stays as it was. */
export function SendSheet(props: SendSheetProps) {
  const { mode } = useWhitechainPayments();
  return mode === "off" ? <NormalSendSheet {...props} /> : <WhitechainSendSheet {...props} />;
}

function NormalSendSheet({ onClose, recipientId }: SendSheetProps) {
  const { state } = useStore();
  const { account, info, localWallet: wallet } = state;
  const main = state.wallet;
  const [step, setStep] = useState<Step>("form");
  // A recipient row fills in its address. Otherwise the person types one.
  const [to, setTo] = useState(state.recipients.find((r) => r.id === recipientId)?.address ?? "");
  const [token, setToken] = useState<Token>("USDC");
  const [raw, setRaw] = useState("");
  // The action stays fixed from the review step on, so a poll cannot change what the owner approves.
  const [action, setAction] = useState<TxAction | null>(null);
  const approval = useWaveApproval(action);

  const address = to.trim();
  const recipient = state.recipients.find((r) => r.address.toLowerCase() === address.toLowerCase());
  const toProblem = address && wallet ? recipientProblem(address, wallet.address) : null;

  // SAMPLE: no WAVE function yet. WAVE has no USDT token, so USDT fills the switch and never sends.
  const isSample = token === "USDT";
  const real = isSample ? undefined : testToken(info);

  const amount = Number.parseFloat(raw) || 0;
  const parsed = real && raw ? parseTokenAmount(raw, real.decimals) : null;
  const units = parsed?.value ? parsed.value : null;
  const balance = main.balances[token];
  const overBalance = real && units !== null ? units > (account ? tokenBalance(account, real.address) : BigInt(0)) : amount > balance;
  const amountError = parsed?.error ?? (overBalance ? `More than your balance of ${fmtToken(balance, token)}` : null);

  const { nameOf, rule, allowed, daily, stop, noMethod } = useSpendCheck(real, units);

  const canContinue = !!address && !toProblem && !!rule && !overBalance && !stop && !noMethod;

  // The first method builds while the owner reads, so Approve goes straight to the device or the scan.
  const firstMethod = allowed[0]?.view.ref;
  const { prebuild } = approval;
  const firstKey = JSON.stringify(firstMethod);
  useEffect(() => {
    if (action && firstMethod) void prebuild(firstMethod);
    // The key stands for the method, because each render makes a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, firstKey, prebuild]);

  const busy = approval.stage.name !== "idle";
  const title = busy
    ? approval.stage.name === "sign"
      ? "Check and approve"
      : "Send money"
    : { form: "Send money", review: "Check and approve" }[step];

  const toReview = () => {
    if (!canContinue || !real || units === null) return;
    setAction({ kind: "transfer", token: real.address, to: address as Address, amount: units.toString() });
    setStep("review");
  };

  return (
    <Sheet title={title} onClose={onClose}>
      {busy && <ApprovingView approval={approval} onDone={onClose} />}

      {!busy && step === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            toReview();
          }}
        >
          <label htmlFor="send-to" className="text-[15px] font-medium text-ink-2">
            To
          </label>
          <input
            id="send-to"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Wallet address, 0x…"
            value={to}
            data-autofocus
            aria-invalid={!!toProblem}
            aria-describedby={toProblem ? "send-to-error" : undefined}
            onChange={(e) => setTo(e.target.value)}
            className={`mt-2 h-13 w-full rounded-2xl bg-surface px-4 font-mono text-[15px] outline-none ring-wave-deep placeholder:font-sans placeholder:text-muted focus-visible:ring-2 ${
              toProblem ? "ring-2 ring-danger" : ""
            }`}
          />
          {toProblem && (
            <p id="send-to-error" className="mt-1.5 text-sm font-semibold text-danger">
              {toProblem}
            </p>
          )}

          <div className="mt-5 rounded-[24px] bg-surface p-4">
            <div className="flex items-center justify-between">
              <label htmlFor="send-amount" className="text-[15px] font-medium text-ink-2">
                Amount
              </label>
              <div className="inline-flex rounded-full bg-white p-1 ring-1 ring-line" role="group" aria-label="Token">
                {(["USDC", "USDT"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={token === t}
                    onClick={() => setToken(t)}
                    className={`flex h-8 items-center gap-1.5 rounded-full pl-1 pr-3 text-sm font-semibold ${token === t ? "bg-ink text-white" : "text-ink-2"} ${focusRing}`}
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
              aria-invalid={!!amountError}
              aria-describedby="amount-help"
              onChange={(e) => {
                const v = e.target.value.replace(",", ".");
                if (/^\d*\.?\d{0,6}$/.test(v)) setRaw(v);
              }}
              className="mt-2 w-full bg-transparent text-[2.5rem] font-bold tabular-nums tracking-tight outline-none placeholder:text-[#b3b3b3]"
            />
            <p id="amount-help" className={`text-sm ${amountError ? "font-semibold text-danger" : "text-muted"}`}>
              {amountError ?? `Balance: ${fmtToken(balance, token)}${daily && real ? ` · ${leftToday(daily, real)}` : ""}`}
            </p>
          </div>

          {isSample && <Stop>USDT is a sample. WAVE has no USDT token, so nothing can be sent.</Stop>}
          {!isSample && !real && <Stop>WAVE has no test USDC on this network, so nothing can be sent.</Stop>}
          {!amountError && stop && <Stop>{stop}</Stop>}
          {!amountError && !stop && noMethod && <Stop>{noMethod}</Stop>}

          <div className="mt-5">
            <PrimaryButton type="submit" disabled={!canContinue}>
              Continue
            </PrimaryButton>
          </div>
        </form>
      )}

      {!busy && step === "review" && real && (
        <div>
          <p className="text-sm text-muted">{info?.gasSponsored ? "Total" : "You send"}</p>
          <p className="text-3xl font-bold tabular-nums tracking-tight">
            {plainAmount(units, real.decimals)} {token}
          </p>

          <ReviewRows
            rows={[
              ["To", recipient ? `${recipient.name} · ${shortAddr(address)}` : shortAddr(address)],
              ["Gas", info?.gasSponsored ? "0 (Sponsored)" : "Paid by this wallet"],
              ["Methods required", allowed.map((choice) => nameOf(choice.view)).join(" or ")],
              ...(rule?.delay ? ([["Timing", `After ${formatDuration(rule.delay).toLowerCase()} · cancellable`]] as const) : []),
            ]}
          />

          {/* A poll can change the balance or the rules while this step is open. */}
          {!canContinue && <Stop>{stop ?? noMethod ?? amountError ?? "This send can no longer run. Edit it first."}</Stop>}

          <div className="mt-5 space-y-2">
            {canContinue && <ApproveButtons choices={allowed} onPick={(method) => void approval.approveNow(method)} />}
            <PrimaryButton
              tone="ghost"
              onClick={() => {
                setAction(null);
                setStep("form");
              }}
            >
              Edit
            </PrimaryButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}
