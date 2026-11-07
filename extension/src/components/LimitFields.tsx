import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  fullMethods,
  lowerChoices,
  pickLower,
  pickUpper,
  type LimitForm,
  type LimitMethod,
  type Row,
} from "../lib/wave/create";
import { KIND_ICON } from "./ui";

/** The limit boxes. The first-run page and the limits page show the same boxes. */

const fieldClass =
  "h-13 w-full rounded-2xl bg-surface px-4 text-base outline-none ring-wave-deep placeholder:text-muted focus-visible:ring-2";

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[15px] font-medium text-ink-2">{label}</span>
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

const SHORT_NAME: Record<string, string> = { key: "Security key", passkey: "Passkey" };

/** One box. With children: the amount on the left and the method on the right. With none: only the method. */
export function LimitBox({
  label,
  methodLabel,
  method,
  methods,
  kindOf,
  invalid,
  onPick,
  children,
}: {
  label: string;
  methodLabel: string;
  method: string;
  methods: LimitMethod[];
  /** Gives the icon of a method. On the first-run page the ID is the row. Later it is the method bit. */
  kindOf: (id: string) => Row;
  invalid?: boolean;
  onPick: (id: string) => void;
  children?: ReactNode;
}) {
  const Icon = KIND_ICON[kindOf(method)];
  return (
    <div>
      <p className="text-sm font-medium text-muted">{label}</p>
      <div className={`mt-1.5 flex h-16 items-center gap-2 rounded-2xl bg-surface pl-4 pr-2 ${invalid ? "ring-2 ring-danger" : ""}`}>
        {children && <div className="flex min-w-0 flex-1 items-baseline gap-1.5">{children}</div>}
        <span
          className={`relative flex h-12 min-w-0 items-center gap-2 rounded-full bg-white pl-3 ring-1 ring-line focus-within:ring-2 focus-within:ring-wave-deep ${
            children ? "max-w-[58%] shrink-0" : "flex-1"
          }`}
        >
          <Icon className="size-5 shrink-0" aria-hidden />
          <select
            aria-label={methodLabel}
            className="h-full w-full min-w-0 cursor-pointer appearance-none truncate bg-transparent pr-8 text-[15px] font-semibold outline-none"
            value={method}
            onChange={(event) => onPick(event.target.value)}
          >
            {methods.map((item) => (
              <option key={item.id} value={item.id}>
                {SHORT_NAME[item.id] ?? item.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 size-4 text-ink-2" aria-hidden />
        </span>
      </div>
    </div>
  );
}

/** The daily total. It applies to every form of a rule. */
export function PerDayField({
  form,
  symbol,
  problem,
  onChange,
}: {
  form: LimitForm;
  symbol: string;
  problem: string | null;
  onChange: (next: LimitForm) => void;
}) {
  return (
    <div>
      <Labeled label={`Most per day in ${symbol}`}>
        <input
          className={`${fieldClass} ${problem ? "ring-2 ring-danger" : ""}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="No limit"
          value={form.perDay}
          onChange={(event) => onChange({ ...form, perDay: event.target.value })}
        />
      </Labeled>
      {problem ? (
        <p className="mt-1.5 text-sm font-semibold text-danger">{problem}</p>
      ) : (
        <p className="mt-1.5 text-sm text-muted">This total counts every method.</p>
      )}
    </div>
  );
}

/** The limit for each transaction, the method on each side of it, and the daily total. */
export function LimitFields({
  form,
  methods,
  symbol,
  problems,
  kindOf,
  onChange,
}: {
  form: LimitForm;
  methods: LimitMethod[];
  symbol: string;
  problems: { amount: string | null; perDay: string | null };
  kindOf: (id: string) => Row;
  onChange: (next: LimitForm) => void;
}) {
  const badAmount = problems.amount !== null && form.amount.trim() !== "";

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-[15px] font-medium text-ink-2">Limit for each transaction</legend>
        <div className="mt-2 space-y-3">
          <LimitBox
            label="Up to this amount"
            methodLabel="Method up to the limit"
            method={form.lower}
            methods={lowerChoices(methods)}
            kindOf={kindOf}
            invalid={badAmount}
            onPick={(id) => onChange(pickLower(form, id, methods))}
          >
            <input
              aria-label={`Limit for each transaction in ${symbol}`}
              className="min-w-[1ch] max-w-full bg-transparent text-xl font-bold outline-none [field-sizing:content]"
              size={Math.max(form.amount.length, 1)}
              inputMode="decimal"
              autoComplete="off"
              value={form.amount}
              onChange={(event) => onChange({ ...form, amount: event.target.value })}
            />
            <span className="shrink-0 text-sm font-semibold text-muted">{symbol}</span>
          </LimitBox>
          {badAmount && <p className="text-sm font-semibold text-danger">{problems.amount}</p>}

          <LimitBox
            label="Over this amount, approve with"
            methodLabel="Method over the limit"
            method={form.upper}
            methods={fullMethods(methods)}
            kindOf={kindOf}
            onPick={(id) => onChange(pickUpper(form, id, methods))}
          />
        </div>
      </fieldset>

      <PerDayField form={form} symbol={symbol} problem={problems.perDay} onChange={onChange} />
    </div>
  );
}
