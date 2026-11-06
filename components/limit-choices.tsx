"use client";

import { useId, type ReactNode } from "react";
import {
  canUseLimit,
  formProblems,
  formSummary,
  fullMethods,
  lowerChoices,
  pickLower,
  pickUpper,
  type LimitForm,
  type LimitMethod,
} from "@/lib/ui/limits";
import type { TokenInfo } from "@/lib/api-types";
import { cn } from "@/lib/ui/cn";
import { fieldStyles } from "./ui";

function Choice({
  name,
  checked,
  disabled,
  title,
  note,
  onPick,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  title: string;
  note?: string;
  onPick: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className={cn("flex min-h-11 items-start gap-3 py-2", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <input
          type="radio"
          name={name}
          checked={checked}
          disabled={disabled}
          onChange={onPick}
          className="mt-0.5 size-5 shrink-0 accent-current"
        />
        <span className={cn("min-w-0 flex-1", disabled && "opacity-60")}>
          <span className="block text-sm font-medium">{title}</span>
          {note ? <span className="block text-sm text-muted-foreground">{note}</span> : null}
        </span>
      </label>
      {children ? <div className="flex flex-col gap-2 ps-8">{children}</div> : null}
    </div>
  );
}

const problemText = "text-sm text-destructive";

/** The two choices, on the creation screen and in Settings. No choice can build a bad rule. */
export function LimitChoices({
  methods,
  form,
  token,
  disabled = false,
  onChange,
}: {
  methods: LimitMethod[];
  form: LimitForm;
  token: TokenInfo;
  disabled?: boolean;
  onChange: (next: LimitForm) => void;
}) {
  const group = useId();
  const problems = formProblems(form, token);
  const limitOn = canUseLimit(methods);
  const owner = methods.find((method) => method.owner);
  const set = (next: Partial<LimitForm>) => onChange({ ...form, ...next });
  const used = form.choice === "every" ? [form.every, owner?.id] : [form.lower, form.upper, owner?.id];
  const unused = methods.some((method) => !used.includes(method.id));

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1" disabled={disabled}>
        <legend className="sr-only">How you approve sends of {token.symbol}</legend>

        <Choice
          name={`${group}-choice`}
          checked={form.choice === "every"}
          title="One method for every send"
          onPick={() => set({ choice: "every" })}
        >
          {form.choice === "every"
            ? methods.map((method) => (
                <Choice
                  key={method.id}
                  name={`${group}-every`}
                  checked={form.every === method.id}
                  disabled={!method.full}
                  title={method.name}
                  note={method.full ? undefined : method.note}
                  onPick={() => set({ every: method.id })}
                />
              ))
            : null}
        </Choice>

        <Choice
          name={`${group}-choice`}
          checked={form.choice === "limit"}
          disabled={!limitOn}
          title="A limit, then a stronger method"
          note={limitOn ? undefined : "Add a second method to use a limit."}
          onPick={() => set({ choice: "limit" })}
        >
          {form.choice === "limit" ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>Up to</span>
                <input
                  aria-label={`Limit in ${token.symbol}`}
                  aria-invalid={problems.amount !== null && form.amount.trim() !== ""}
                  className={cn(fieldStyles, "w-24!")}
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.amount}
                  onChange={(event) => set({ amount: event.target.value })}
                />
                <span>{token.symbol}, approve with</span>
                <select
                  aria-label="Method up to the limit"
                  className={cn(fieldStyles, "w-auto! min-w-40 flex-1")}
                  value={form.lower}
                  onChange={(event) => onChange(pickLower(form, event.target.value, methods))}
                >
                  {lowerChoices(methods).map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.name}
                    </option>
                  ))}
                </select>
              </div>
              {problems.amount && form.amount.trim() ? <p className={problemText}>{problems.amount}</p> : null}

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>Above that, approve with</span>
                <select
                  aria-label="Method above the limit"
                  className={cn(fieldStyles, "w-auto! min-w-40 flex-1")}
                  value={form.upper}
                  onChange={(event) => onChange(pickUpper(form, event.target.value, methods))}
                >
                  {fullMethods(methods).map((method) => (
                    <option key={method.id} value={method.id}>
                      {method.name}
                    </option>
                  ))}
                </select>
              </div>

            </>
          ) : null}
        </Choice>

        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Most I can spend per day:</span>
            <span className="flex items-center gap-2">
              <input
                aria-label={`Most per day in ${token.symbol}`}
                aria-invalid={problems.perDay !== null}
                className={cn(fieldStyles, "w-24!")}
                inputMode="decimal"
                autoComplete="off"
                placeholder="No limit"
                value={form.perDay}
                onChange={(event) => set({ perDay: event.target.value })}
              />
              <span>{token.symbol}</span>
            </span>
          </div>
          {problems.perDay ? <p className={problemText}>{problems.perDay}</p> : null}
          <p className="text-sm text-muted-foreground">
            This total counts every method. Each day starts at your first send and runs for 24 hours.
          </p>
        </div>
      </fieldset>

      <div className="rounded-xl bg-muted p-3 text-sm" aria-live="polite">
        {formSummary(form, methods, token).map((line) => (
          <p key={line} className="font-medium">
            {line}
          </p>
        ))}
        {unused ? (
          <p className="mt-1 text-muted-foreground">
            Your other methods do not approve sends. They can still cancel queued actions.
          </p>
        ) : null}
      </div>
    </div>
  );
}
