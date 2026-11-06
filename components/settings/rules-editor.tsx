"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ApproveFlow,
  anyMethod,
  requireMethod,
  type ApprovalRequest,
} from "@/components/approve-flow";
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
import { WORLD_METHOD_MASK, type MethodView, type Tier, type TierView, type TokenInfo } from "@/lib/api-types";
import { cn } from "@/lib/ui/cn";
import { formatDuration, parseTokenAmount, plainAmount } from "@/lib/ui/format";
import {
  WORLD_ID,
  compareRules,
  maskHas,
  methodLabel,
  tierAmountError,
  validateTiers,
} from "@/lib/ui/rules";

const HOUR = 3600;
const DAY = 24 * HOUR;
const DELAYS = [0, HOUR, DAY, 2 * DAY, 7 * DAY];
const LOOSEN_DELAY = 2 * DAY;
const PERIODS = [
  { value: DAY, label: "Day" },
  { value: 7 * DAY, label: "Week" },
];

/** A tier row as the owner types it. Amounts are text in whole tokens. */
type DraftRow = {
  key: number;
  upTo: string;
  cap: string;
  delay: number;
  period: number;
  methods: number;
  small: boolean;
};

function toDraft(tiers: TierView[], token: TokenInfo): DraftRow[] {
  return tiers.map((tier, key) => ({
    key,
    upTo: plainAmount(tier.upTo, token.decimals),
    cap: tier.cap === "0" ? "" : plainAmount(tier.cap, token.decimals),
    delay: tier.delay,
    period: tier.period,
    methods: tier.methods,
    small: tier.small,
  }));
}

/** Text that cannot be read counts as 0 here. `rowProblems` stops the save for that text. */
function toBase(text: string, token: TokenInfo): string {
  return (parseTokenAmount(text, token.decimals).value ?? BigInt(0)).toString();
}

/** Amount fields that the app cannot read exactly. A typo must never become "no cap". */
function rowProblems(rows: DraftRow[], token: TokenInfo): string[] {
  return rows.flatMap((row, index) => {
    const upTo = tierAmountError(row.upTo, token, false);
    const cap = tierAmountError(row.cap, token, true);
    return [
      ...(upTo ? [`Tier ${index + 1} upper amount: ${upTo}`] : []),
      ...(cap ? [`Tier ${index + 1} period cap: ${cap}`] : []),
    ];
  });
}

function fromDraft(rows: DraftRow[], token: TokenInfo): Tier[] {
  return rows.map((row) => {
    const cap = toBase(row.cap, token);
    return {
      upTo: toBase(row.upTo, token),
      cap,
      delay: row.delay,
      // The Period field shows Day for a row with no period, so that is the value here too.
      period: cap === "0" ? 0 : row.period || DAY,
      methods: row.methods,
      small: row.small,
    };
  });
}

function MethodToggle({
  method,
  on,
  warn,
  onToggle,
}: {
  method: MethodView;
  on: boolean;
  warn: boolean;
  onToggle: () => void;
}) {
  const { info } = useWallet();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={warn ? "A synced passkey approves small tiers only." : undefined}
      className={cn(
        `min-h-10 rounded-lg border border-border px-3 text-sm font-medium ${focusRing}`,
        on ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
      )}
    >
      {methodLabel(method.ref, info?.world)}
    </button>
  );
}

function TierRow({
  row,
  index,
  token,
  methods,
  onChange,
  onRemove,
}: {
  row: DraftRow;
  index: number;
  token: TokenInfo;
  methods: MethodView[];
  onChange: (next: DraftRow) => void;
  onRemove: () => void;
}) {
  const syncedOnLargeTier =
    !row.small && methods.some((m) => m.backup === "synced" && maskHas(row.methods, m));

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Tier {index + 1}</h3>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove tier ${index + 1}`}
          className={`inline-flex size-10 items-center justify-center rounded-lg hover:bg-muted ${focusRing}`}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field
          label={`Up to (${token.symbol})`}
          value={row.upTo}
          inputMode="decimal"
          autoComplete="off"
          error={row.upTo ? tierAmountError(row.upTo, token, false) : null}
          onChange={(event) => onChange({ ...row, upTo: event.target.value })}
        />
        <SelectField
          label="Delay"
          value={row.delay}
          onChange={(event) => onChange({ ...row, delay: Number(event.target.value) })}
        >
          {[...new Set([...DELAYS, row.delay])].map((delay) => (
            <option key={delay} value={delay}>
              {formatDuration(delay)}
            </option>
          ))}
        </SelectField>
        <Field
          label={`Period cap (${token.symbol})`}
          value={row.cap}
          placeholder="No cap"
          inputMode="decimal"
          autoComplete="off"
          error={tierAmountError(row.cap, token, true)}
          onChange={(event) => onChange({ ...row, cap: event.target.value })}
        />
        <SelectField
          label="Period"
          value={row.period || DAY}
          disabled={!row.cap.trim()}
          onChange={(event) => onChange({ ...row, period: Number(event.target.value) })}
        >
          {PERIODS.map((period) => (
            <option key={period.value} value={period.value}>
              {period.label}
            </option>
          ))}
        </SelectField>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Methods</legend>
        <div className="flex flex-wrap gap-2">
          {methods.map((method) => (
            <MethodToggle
              key={method.validator}
              method={method}
              on={maskHas(row.methods, method)}
              warn={method.backup === "synced" && !row.small}
              onToggle={() =>
                onChange({ ...row, methods: row.methods ^ method.mask })
              }
            />
          ))}
        </div>
      </fieldset>

      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={row.small}
          className="size-4 accent-current"
          onChange={(event) => onChange({ ...row, small: event.target.checked })}
        />
        Small tier: synced passkeys can approve it
      </label>

      {syncedOnLargeTier ? (
        <Notice tone="warning">
          This tier names a synced passkey, but it is not a small tier. The account will reject
          that passkey here.
        </Notice>
      ) : null}
    </li>
  );
}

function Editor({
  token,
  chainTiers,
  chainRows,
  methods,
  demoDelay,
  onRequest,
}: {
  token: TokenInfo;
  chainTiers: TierView[];
  chainRows: DraftRow[];
  methods: MethodView[];
  demoDelay: number;
  onRequest: (request: ApprovalRequest) => void;
}) {
  const { info } = useWallet();
  const [rows, setRows] = useState<DraftRow[]>(chainRows);
  const [nextKey, setNextKey] = useState(chainRows.length);
  const [reviewing, setReviewing] = useState(false);

  const draft = useMemo(() => fromDraft(rows, token), [rows, token]);
  const change = useMemo(
    () => compareRules(chainTiers, draft, token, methods, info?.world),
    [chainTiers, draft, token, methods, info?.world],
  );
  const problems = useMemo(() => {
    const unreadable = rowProblems(rows, token);
    // A row with unreadable text would add a second, wrong problem.
    return unreadable.length > 0 ? unreadable : validateTiers(draft, token);
  }, [rows, draft, token]);

  const update = (index: number, next: DraftRow) =>
    setRows(rows.map((row, at) => (at === index ? next : row)));

  const addRow = () => {
    const last = rows[rows.length - 1];
    setRows([
      ...rows,
      {
        key: nextKey,
        upTo: "",
        cap: "",
        delay: 0,
        period: DAY,
        methods: last ? last.methods : WORLD_METHOD_MASK,
        small: false,
      },
    ]);
    setNextKey(nextKey + 1);
  };

  const save = () => {
    if (change.direction === "stricter") {
      onRequest({
        action: { kind: "tighten", token: token.address, tiers: draft },
        choices: anyMethod(methods),
        method: methods.length === 1 ? methods[0].ref : undefined,
        note: "Stricter rules apply at once. Any enrolled method can approve them.",
      });
    } else {
      onRequest({
        action: { kind: "set-rules", token: token.address, tiers: draft },
        choices: requireMethod(methods, WORLD_ID, info?.world),
        method: WORLD_ID,
      });
    }
    setReviewing(false);
  };

  const isChanged = change.direction !== "same";

  return (
    <>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tiers. The default rule applies: World ID only, no delay.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <TierRow
              key={row.key}
              row={row}
              index={index}
              token={token}
              methods={methods}
              onChange={(next) => update(index, next)}
              onRemove={() => setRows(rows.filter((_, at) => at !== index))}
            />
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <Button variant="secondary" onClick={addRow}>
          <Plus aria-hidden="true" className="size-4" />
          Add tier
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
        <Button disabled={!isChanged || problems.length > 0} onClick={() => setReviewing(true)}>
          Review changes
        </Button>
      </div>

      {reviewing ? (
        <Sheet title="Review changes" onClose={() => setReviewing(false)}>
          <div className="flex flex-col gap-3">
            <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
              {change.changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {change.direction === "stricter" ? (
              <Notice tone="success" title="These rules are stricter">
                They apply at once. Any enrolled method can approve.
              </Notice>
            ) : (
              <Notice tone="warning" title="These rules are looser">
                This needs World ID, and it waits in the queue.{" "}
                {demoDelay > 0 && demoDelay < LOOSEN_DELAY
                  ? `Demo delay: ${formatDuration(demoDelay).toLowerCase()} (real: 48 hours).`
                  : "The delay is 48 hours."}{" "}
                You can cancel it during that time. The old rules apply until it runs.
              </Notice>
            )}
            <Button onClick={save}>Continue</Button>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

export function RulesEditor() {
  const { account, info } = useWallet();
  const [tokenAddress, setTokenAddress] = useState<string | null>(null);
  // This sheet stays here. A rule change remounts the Editor, and the sheet must keep its result.
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  // A queued change leaves the chain as it was. The draft must go back to the live rules.
  const [saves, setSaves] = useState(0);

  if (!account || !info) return null;

  const token =
    info.tokens.find((t) => t.address === tokenAddress) ??
    info.tokens.find((t) => t.isTest) ??
    info.tokens[0];
  if (!token) return null;

  const chainTiers = account.rules.find((r) => r.token === token.address)?.tiers ?? [];
  // Counters change with each poll. A new key means that the rules changed.
  const signature = JSON.stringify(
    chainTiers.map(({ upTo, cap, delay, period, methods, small }) => [
      upTo,
      cap,
      delay,
      period,
      methods,
      small,
    ]),
  );

  const queued = account.pending.filter(
    (action) => action.status !== "stale" && action.decoded.title === `Change ${token.symbol} rules`,
  );

  return (
    <Card>
      <SectionTitle hint="Each tier names an upper amount, the methods that approve it, a delay and a period cap.">
        Spending rules
      </SectionTitle>
      <SelectField
        label="Token"
        className="mb-3"
        value={token.address}
        onChange={(event) => setTokenAddress(event.target.value)}
      >
        {info.tokens.map((item) => (
          <option key={item.address} value={item.address}>
            {item.isTest ? item.name : item.symbol}
          </option>
        ))}
      </SelectField>
      {queued.length > 0 ? (
        <Notice tone="warning" title="A rule change waits in the queue" className="mb-3">
          The rows below are the live rules. They change when the queued action runs. See Pending
          actions on the Wallet page.
        </Notice>
      ) : null}
      <Editor
        key={`${token.address}:${signature}:${saves}`}
        token={token}
        chainTiers={chainTiers}
        chainRows={toDraft(chainTiers, token)}
        methods={account.methods}
        demoDelay={account.demoDelay}
        onRequest={setRequest}
      />
      {request ? (
        <Sheet title="Save rules" onClose={() => setRequest(null)}>
          <ApproveFlow request={request} onDone={() => setSaves((count) => count + 1)} />
        </Sheet>
      ) : null}
    </Card>
  );
}
