import { turnOffWhitechain, turnOnWhitechain, useWhitechainPayments } from "../lib/wc/switch";
import { Switch } from "./ui";

/** The row in Account details. A failed check shows its reason, and the switch stays off. */
export function WhitechainSwitchRow() {
  const { mode, reason } = useWhitechainPayments();
  const hint = { off: "Send uses the WAVE network.", checking: "Checking Whitechain…", on: "Send uses USDT on Whitechain Sepolia." }[mode];
  return (
    <div className="mx-5 mt-4 rounded-[24px] bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold">Whitechain payments</p>
          <p className="mt-0.5 text-sm text-muted" aria-live="polite">
            {hint}
          </p>
        </div>
        <Switch
          checked={mode === "on"}
          label="Whitechain payments"
          onChange={() => {
            if (mode === "on") turnOffWhitechain();
            else if (mode === "off") turnOnWhitechain();
          }}
        />
      </div>
      {reason && (
        <p className="mt-3 text-sm font-semibold leading-snug text-danger" role="alert">
          Whitechain payments stay off. {reason}
        </p>
      )}
    </div>
  );
}

/** The small line on Home. It shows nothing while the switch is off. */
export function WhitechainLine() {
  const { mode } = useWhitechainPayments();
  if (mode !== "on") return null;
  return <p className="mt-1 text-sm font-semibold text-wave-deep">Whitechain payments on</p>;
}
