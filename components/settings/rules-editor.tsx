"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ApproveFlow,
  anyMethod,
  requireMethod,
  type ApprovalRequest,
} from "@/components/approve-flow";
import { LimitChoices } from "@/components/limit-choices";
import {
  Button,
  Card,
  Field,
  Notice,
  SectionTitle,
  SelectField,
  Sheet,
  focusRing,
} from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import {
  OWNER_METHOD_MASK,
  type DailyView,
  type MethodRef,
  type MethodView,
  type Tier,
  type TierView,
  type TokenInfo,
} from "@/lib/api-types";
import { NO_LIMIT } from "@/lib/policy";
import { cn } from "@/lib/ui/cn";
import { formatDuration, parseTokenAmount, plainAmount } from "@/lib/ui/format";
import {
  defaultForm,
  fitForm,
  formDailyLimit,
  formIsValid,
  formTiers,
  leftToday,
  liveDaily,
  readForm,
  ruleSentences,
  sameForm,
  type LimitForm,
  type LimitMethod,
} from "@/lib/ui/limits";
import { compareRules, dailyDirection, joinDirections, maskHas, plainName, saveLine, tierAmountError } from "@/lib/ui/rules";
import { useNow } from "@/lib/ui/use-now";

const HOUR = 3600;
const DAY = 24 * HOUR;
const DELAYS = [0, HOUR, DAY, 2 * DAY, 7 * DAY];
const LOOSEN_DELAY = 2 * DAY;
const SPANS = [
  { value: DAY, label: "Day" },
  { value: 7 * DAY, label: "Week" },
];
/** The usual first limit for a test token. A real token starts empty. */
const TEST_LIMIT = "100";

/** One step of the Advanced editor. Amounts are text in whole tokens. */
type Step = {
  key: number;
  upTo: string;
  cap: string;
  delay: number;
  span: number;
  methods: number;
  /** The live rule already lets synced passkeys use this step. */
  small: boolean;
};

const isSynced = (view: MethodView) => view.backup === "synced" && !view.owner;

/**
 * The last step has no upper amount, and it always holds the owner method. The owner method cannot
 * be removed, so a large send always has an approver. A removed method does not stay in a step.
 */
function toSteps(tiers: TierView[], token: TokenInfo, methods: MethodView[]): Step[] {
  const enrolled = methods.reduce((mask, view) => mask | view.mask, 0);
  const steps = tiers.map((tier, key) => ({
    key,
    upTo: plainAmount(tier.upTo, token.decimals),
    cap: tier.cap === "0" ? "" : plainAmount(tier.cap, token.decimals),
    delay: tier.delay,
    span: tier.period,
    methods: tier.methods & enrolled,
    small: tier.small,
  }));
  const last = tiers[tiers.length - 1];
  const open = last !== undefined && BigInt(last.upTo) >= NO_LIMIT && last.cap === "0";
  if (!open) {
    return [...steps, { key: steps.length, upTo: "", cap: "", delay: 0, span: 0, methods: OWNER_METHOD_MASK, small: false }];
  }
  return steps.map((step, index) =>
    index === steps.length - 1 ? { ...step, methods: step.methods | OWNER_METHOD_MASK } : step,
  );
}

const toBase = (text: string, token: TokenInfo) => (parseTokenAmount(text, token.decimals).value ?? BigInt(0)).toString();

function stepTiers(steps: Step[], token: TokenInfo, methods: MethodView[]): Tier[] {
  return steps.map((step, index) => {
    const last = index === steps.length - 1;
    const cap = last ? "0" : toBase(step.cap, token);
    return {
      upTo: last ? NO_LIMIT.toString() : toBase(step.upTo, token),
      cap,
      delay: step.delay,
      // The field shows Day for a step with no time span, so that is the value here too.
      period: cap === "0" ? 0 : step.span || DAY,
      methods: step.methods,
      small: step.small || methods.some((view) => isSynced(view) && maskHas(step.methods, view)),
    };
  });
}

function stepProblems(steps: Step[], token: TokenInfo, methods: MethodView[]): string[] {
  return steps.flatMap((step, index) => {
    const name = `Step ${index + 1}`;
    const last = index === steps.length - 1;
    const problems: string[] = [];
    if (step.methods === 0) problems.push(`${name}: pick a method.`);
    if (last) {
      const full = methods.some((view) => maskHas(step.methods, view) && !isSynced(view));
      if (step.methods !== 0 && !full) problems.push(`${name}: a synced passkey needs a limit, so add another method.`);
      return problems;
    }
    const upTo = tierAmountError(step.upTo, token, false);
    const cap = tierAmountError(step.cap, token, true);
    if (upTo) problems.push(`${name}: ${upTo}`);
    if (cap) problems.push(`${name}: ${cap}`);
    const value = BigInt(toBase(step.upTo, token));
    if (!upTo && value === BigInt(0)) problems.push(`${name}: enter an amount above 0.`);
    if (index > 0 && !upTo && value < BigInt(toBase(steps[index - 1].upTo, token))) {
      problems.push(`${name}: this amount must not be below the step before it.`);
    }
    return problems;
  });
}

function StepRow({
  step,
  index,
  last,
  canRemove,
  token,
  methods,
  nameOf,
  onChange,
  onRemove,
}: {
  step: Step;
  index: number;
  last: boolean;
  canRemove: boolean;
  token: TokenInfo;
  methods: MethodView[];
  nameOf: (view: MethodView) => string;
  onChange: (next: Step) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{last ? "Any amount above that" : `Step ${index + 1}`}</h3>
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove step ${index + 1}`}
            className={`inline-flex size-10 items-center justify-center rounded-lg hover:bg-muted ${focusRing}`}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {last ? null : (
          <Field
            label={`Up to (${token.symbol})`}
            value={step.upTo}
            inputMode="decimal"
            autoComplete="off"
            error={step.upTo ? tierAmountError(step.upTo, token, false) : null}
            onChange={(event) => onChange({ ...step, upTo: event.target.value })}
          />
        )}
        <SelectField
          label="Delay"
          value={step.delay}
          onChange={(event) => onChange({ ...step, delay: Number(event.target.value) })}
        >
          {[...new Set([...DELAYS, step.delay])].map((delay) => (
            <option key={delay} value={delay}>
              {formatDuration(delay)}
            </option>
          ))}
        </SelectField>
        {last ? null : (
          <>
            <Field
              label={`Most in total (${token.symbol})`}
              value={step.cap}
              placeholder="No limit"
              inputMode="decimal"
              autoComplete="off"
              error={tierAmountError(step.cap, token, true)}
              onChange={(event) => onChange({ ...step, cap: event.target.value })}
            />
            <SelectField
              label="Per"
              value={step.span || DAY}
              disabled={!step.cap.trim()}
              onChange={(event) => onChange({ ...step, span: Number(event.target.value) })}
            >
              {SPANS.map((span) => (
                <option key={span.value} value={span.value}>
                  {span.label}
                </option>
              ))}
            </SelectField>
          </>
        )}
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Who approves</legend>
        <div className="flex flex-wrap gap-2">
          {methods.map((method) => {
            const on = maskHas(step.methods, method);
            // A synced passkey cannot approve any amount, so it cannot stand alone in the last step.
            const needsLimit = last && isSynced(method) && !on;
            // The owner method stays in the last step, so a large send always has an approver.
            const held = last && method.owner;
            return (
              <button
                key={method.validator}
                type="button"
                aria-pressed={on}
                disabled={needsLimit || held}
                title={needsLimit ? "A synced passkey needs a limit." : held ? "The owner method can always approve a large send." : undefined}
                onClick={() => onChange({ ...step, methods: step.methods ^ method.mask })}
                className={cn(
                  `min-h-10 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-50 ${focusRing}`,
                  on ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                )}
              >
                {nameOf(method)}
              </button>
            );
          })}
        </div>
        {last ? (
          <p className="mt-2 text-sm text-muted-foreground">
            The owner method stays here, so a large send always has an approver.
            {methods.some(isSynced) ? " A synced passkey needs a limit, so it cannot approve here." : ""}
          </p>
        ) : null}
      </fieldset>
    </li>
  );
}

function SaveArea({
  line,
  disabled,
  label,
  onSave,
}: {
  line: string | null;
  disabled: boolean;
  label: string;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
      <Button disabled={disabled} onClick={onSave}>
        {label}
      </Button>
    </div>
  );
}

function Advanced({
  token,
  chainTiers,
  methods,
  ownerName,
  waitSeconds,
  nameOf,
  onSave,
}: {
  token: TokenInfo;
  chainTiers: TierView[];
  methods: MethodView[];
  ownerName: string;
  waitSeconds: number | null;
  nameOf: (view: MethodView) => string;
  onSave: (draft: Tier[], direction: "stricter" | "looser") => void;
}) {
  const { info } = useWallet();
  const [steps, setSteps] = useState<Step[]>(() => toSteps(chainTiers, token, methods));
  const [nextKey, setNextKey] = useState(steps.length);

  const problems = useMemo(() => stepProblems(steps, token, methods), [steps, token, methods]);
  const draft = useMemo(() => stepTiers(steps, token, methods), [steps, token, methods]);
  const change = useMemo(
    () => compareRules(chainTiers, draft, token, methods, info?.world),
    [chainTiers, draft, token, methods, info?.world],
  );

  const addStep = () => {
    const before = steps[steps.length - 2];
    const fresh: Step = {
      key: nextKey,
      upTo: "",
      cap: "",
      delay: 0,
      span: DAY,
      methods: before ? before.methods : OWNER_METHOD_MASK,
      small: false,
    };
    setSteps([...steps.slice(0, -1), fresh, steps[steps.length - 1]]);
    setNextKey(nextKey + 1);
  };

  const direction = change.direction === "same" ? null : change.direction;

  return (
    <details className="mt-3 rounded-xl border border-border">
      <summary className={`min-h-11 cursor-pointer rounded-xl px-3 py-3 text-sm font-medium ${focusRing}`}>
        Advanced
      </summary>
      <div className="flex flex-col gap-3 p-3 pt-0">
        <p className="text-sm text-muted-foreground">
          Use this for a delay on large sends, a weekly total, or more than two steps.
        </p>
        <ul className="flex flex-col gap-3">
          {steps.map((step, index) => (
            <StepRow
              key={step.key}
              step={step}
              index={index}
              last={index === steps.length - 1}
              canRemove={steps.length > 1 && index < steps.length - 1}
              token={token}
              methods={methods}
              nameOf={nameOf}
              onChange={(next) => setSteps(steps.map((item, at) => (at === index ? next : item)))}
              onRemove={() => setSteps(steps.filter((_, at) => at !== index))}
            />
          ))}
        </ul>
        <Button variant="secondary" onClick={addStep}>
          <Plus aria-hidden="true" className="size-4" />
          Add a step
        </Button>
        {problems.length > 0 ? (
          <Notice tone="warning" title="Fix these first">
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <SaveArea
          line={direction && problems.length === 0 ? saveLine(direction, ownerName, waitSeconds, LOOSEN_DELAY) : null}
          disabled={direction === null || problems.length > 0}
          label="Save these steps"
          onSave={() => direction && onSave(draft, direction)}
        />
      </div>
    </details>
  );
}

function Editor({
  token,
  chainTiers,
  daily,
  methods,
  owner,
  waitSeconds,
  onRequest,
}: {
  token: TokenInfo;
  chainTiers: TierView[];
  daily: DailyView | null;
  methods: MethodView[];
  owner: MethodRef;
  waitSeconds: number | null;
  onRequest: (request: ApprovalRequest) => void;
}) {
  const { info, wallet, local } = useWallet();
  const nameOf = (view: MethodView) => plainName(view, wallet, local, info?.world);
  const choices: LimitMethod[] = methods.map((view) => ({
    id: String(view.mask),
    name: nameOf(view),
    owner: view.owner,
    full: !isSynced(view),
    note: isSynced(view) ? "A synced passkey needs a limit." : undefined,
  }));
  const ownerView = methods.find((view) => view.owner);
  const ownerName = ownerView ? nameOf(ownerView) : "the owner method";

  const chainLimit = daily?.limit ?? "0";
  const live = readForm(chainTiers, choices, token, chainLimit);
  const firstLimit = token.isTest ? TEST_LIMIT : "";
  // A rule that the choices cannot show still has a daily limit, and a save must not drop it.
  const [draftForm, setForm] = useState<LimitForm>(() =>
    live
      ? { ...live, amount: live.amount || firstLimit }
      : { ...defaultForm(choices, firstLimit), perDay: chainLimit === "0" ? "" : plainAmount(chainLimit, token.decimals) },
  );
  const form = fitForm(draftForm, choices);

  const valid = formIsValid(form, token);
  const draft = valid ? formTiers(form, choices, token) : null;
  const unchanged = live !== null && sameForm(form, live, token);
  const draftLimit = formDailyLimit(form, token);
  const change = draft && !unchanged ? compareRules(chainTiers, draft, token, methods, info?.world) : null;
  const joined = change ? joinDirections(change.direction, dailyDirection(chainLimit, draftLimit)) : "same";
  const direction = joined !== "same" ? joined : null;

  const save = (tiers: Tier[], how: "stricter" | "looser", dailyLimit: string) => {
    if (how === "stricter") {
      onRequest({
        action: { kind: "tighten", token: token.address, tiers, dailyLimit },
        choices: anyMethod(methods),
        method: methods.length === 1 ? methods[0].ref : undefined,
        note: "Stricter limits apply at once. Any enrolled method can approve them.",
      });
    } else {
      onRequest({
        action: { kind: "set-rules", token: token.address, tiers, dailyLimit },
        choices: requireMethod(methods, owner, info?.world),
        method: owner,
      });
    }
  };

  return (
    <>
      <div className="mb-3 text-sm">
        <p className="text-muted-foreground">Your limit now</p>
        {ruleSentences(chainTiers, choices, token, chainLimit).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {daily ? <p className="mt-1 font-medium">{leftToday(daily, token)}</p> : null}
      </div>
      {live === null ? (
        <Notice className="mb-3" title="This limit does not fit the two choices below">
          Pick a choice to replace it, or change the steps in Advanced.
        </Notice>
      ) : null}

      <div className="flex flex-col gap-3">
        <LimitChoices methods={choices} form={form} token={token} onChange={setForm} />
        <SaveArea
          line={direction ? saveLine(direction, ownerName, waitSeconds, LOOSEN_DELAY) : null}
          disabled={direction === null || draft === null}
          label="Save"
          onSave={() => draft && direction && save(draft, direction, draftLimit)}
        />
      </div>

      <Advanced
        token={token}
        chainTiers={chainTiers}
        methods={methods}
        ownerName={ownerName}
        waitSeconds={waitSeconds}
        nameOf={nameOf}
        onSave={(tiers, how) => save(tiers, how, chainLimit)}
      />
    </>
  );
}

function TokenLimits({ token }: { token: TokenInfo }) {
  const { account } = useWallet();
  const now = useNow();
  // This sheet stays here. A saved change remounts the Editor, and the sheet must keep its result.
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  // A queued change leaves the chain as it was. The form must go back to the live limits.
  const [saves, setSaves] = useState(0);

  if (!account) return null;

  const chainRule = account.rules.find((r) => r.token === token.address);
  const chainTiers = chainRule?.tiers ?? [];
  const daily = liveDaily(chainRule?.daily, now);
  // Counters change with each poll. A new key means that the limits changed.
  const signature = JSON.stringify([
    daily?.limit ?? "0",
    ...chainTiers.map(({ upTo, cap, delay, period, methods, small }) => [upTo, cap, delay, period, methods, small]),
  ]);
  const queued = account.pending.filter(
    (action) => action.status !== "stale" && action.decoded.title === `Change ${token.symbol} rules`,
  );

  return (
    <Card>
      <SectionTitle hint="Choose who approves each send.">
        Spending limits: {token.isTest ? token.name : token.symbol}
      </SectionTitle>
      {queued.length > 0 ? (
        <Notice tone="warning" title="A limit change is waiting" className="mb-3">
          Your limit stays the same until it runs. See Pending actions on the Wallet page.
        </Notice>
      ) : null}
      <Editor
        key={`${signature}:${saves}:${account.methods.length}`}
        token={token}
        chainTiers={chainTiers}
        daily={daily}
        methods={account.methods}
        owner={account.owner}
        waitSeconds={account.waitSeconds}
        onRequest={setRequest}
      />
      {request ? (
        <Sheet title="Save limits" onClose={() => setRequest(null)}>
          <ApproveFlow request={request} onDone={() => setSaves((count) => count + 1)} />
        </Sheet>
      ) : null}
    </Card>
  );
}

export function RulesEditor() {
  const { account, info } = useWallet();
  if (!account || !info) return null;
  return (
    <>
      {info.tokens.map((token) => (
        <TokenLimits key={token.address} token={token} />
      ))}
    </>
  );
}
