"use client";

import { fieldStyles } from "@/components/ui";
import type { TokenInfo } from "@/lib/api-types";
import { limitProblems, limitSummary, type LimitDraft } from "@/lib/ui/agents";
import { cn } from "@/lib/ui/cn";

function AmountRow({
  label,
  name,
  symbol,
  value,
  placeholder,
  problem,
  onChange,
}: {
  label: string;
  name: string;
  symbol: string;
  value: string;
  placeholder: string;
  problem: string | null;
  onChange: (value: string) => void;
}) {
  // An empty field is not an error to show. Save stays off until both fields are valid.
  const shown = value.trim() ? problem : null;
  return (
    <div className="flex flex-col gap-1">
      <label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          <input
            name={name}
            aria-invalid={shown !== null}
            className={cn(fieldStyles, "w-24!", shown && "border-destructive")}
            inputMode="decimal"
            autoComplete="off"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <span>{symbol}</span>
        </span>
      </label>
      {shown ? <p className="text-sm text-destructive">{shown}</p> : null}
    </div>
  );
}

/** The two limits of an agent. The create form and the Limits sheet both use these fields. */
export function LimitFields({
  draft,
  token,
  onChange,
}: {
  draft: LimitDraft;
  token: TokenInfo;
  onChange: (draft: LimitDraft) => void;
}) {
  const problems = limitProblems(draft, token);
  const summary = limitSummary(draft, token);
  return (
    <div className="flex flex-col gap-2">
      <AmountRow
        label="Agent can send alone up to"
        name="agent-alone"
        symbol={token.symbol}
        value={draft.alone}
        placeholder="0.00"
        problem={problems.alone}
        onChange={(alone) => onChange({ ...draft, alone })}
      />
      <AmountRow
        label="Most per day"
        name="agent-per-day"
        symbol={token.symbol}
        value={draft.perDay}
        placeholder="Required"
        problem={problems.perDay}
        onChange={(perDay) => onChange({ ...draft, perDay })}
      />
      <p className="text-sm text-muted-foreground">
        Above the alone amount, the agent waits for a World ID login, also if your wallet has no World ID method.
        Nothing goes above the most per day, also when you approve.
      </p>
      {summary ? (
        <p className="rounded-xl bg-muted p-3 text-sm font-medium" aria-live="polite">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
