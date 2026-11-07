import { useState, type ReactNode } from "react";
import { Check, Fingerprint, Globe, KeyRound, RefreshCw, ServerOff, Timer, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  CREATE_SIGNAL,
  api,
  errorText,
  formIsValid,
  passkeyErrorText,
  passkeysSupported,
  testToken,
  type Hex,
  type PlanOwner,
  type WorldProof,
  type WorldVerifyRequest,
} from "../lib/wave";
import {
  ROW_PROMPT,
  SECURITY_LEVELS,
  WAITS,
  abilitiesOf,
  formProblems,
  limitForm,
  limitMethods,
  makeKey,
  saveWallet,
  securityScore,
  setupPages,
  tickedRows,
  type KeyRow,
  type Keys,
  type LimitForm,
  type Row,
  type Ticks,
} from "../lib/wave/create";
import { useStore } from "../store";
import { LimitFields } from "../components/LimitFields";
import { BackButton, KIND_ICON, PrimaryButton, Switch, WaveMark, focusRing } from "../components/ui";
import { WorldScan } from "../components/WorldScan";

function TickRow({
  icon: Icon,
  title,
  detail,
  checked,
  disabled,
  owner,
  onToggle,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  owner?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left ring-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-wave-mist ring-wave-deep" : "bg-surface ring-transparent hover:bg-surface-2"
      } ${focusRing}`}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line" aria-hidden>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-muted">{owner ? "Owner method · big sends and changes" : detail}</span>
      </span>
      {checked && <Check className="size-5 shrink-0 text-wave-deep" aria-hidden />}
    </button>
  );
}

/** The bar on top of each page after the first. The ticks on the first page set the step count. */
function StepBar({ step, total, onBack }: { step: number; total: number; onBack: () => void }) {
  return (
    <div className="flex h-11 items-center gap-3">
      <BackButton onClick={onBack} />
      <div className="flex flex-1 gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, index) => (
          <span key={index} className={`h-1.5 flex-1 rounded-full ${index < step ? "bg-wave-deep" : "bg-surface-2"}`} />
        ))}
      </div>
      <span className="shrink-0 text-sm font-semibold text-muted">
        Step {step} of {total}
      </span>
    </div>
  );
}

const KEY_PAGE: Record<KeyRow, { title: string; body: string; action: string; Icon: LucideIcon }> = {
  passkey: { title: "Add your passkey", body: "Use Face ID or Touch ID on this device.", action: "Add passkey", Icon: Fingerprint },
  key: { title: "Add your security key", body: "Plug in your key or tap it.", action: "Add security key", Icon: KeyRound },
};

/** One method's page: a large icon, what to do, and one button at the bottom. */
function SetupPanel({
  bar,
  icon: Icon,
  done,
  title,
  body,
  children,
}: {
  bar: ReactNode;
  icon: LucideIcon;
  done?: boolean;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col px-6 pb-10 pt-6">
      {bar}
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <span className="grid size-24 place-items-center rounded-full bg-wave-soft text-wave-deep" aria-hidden>
          {done ? <Check className="size-10" /> : <Icon className="size-10" strokeWidth={1.7} />}
        </span>
        <h1 className="mt-6 text-[2rem] font-bold leading-tight tracking-tight">{title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{body}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

/** Shows how strong the ticked mix is. It keeps the two real warnings about a weak mix. */
function SecurityMeter({ ticks }: { ticks: Ticks }) {
  const score = securityScore(ticks);
  const count = Object.values(ticks).filter(Boolean).length;
  const level = score === 0 ? "None" : SECURITY_LEVELS[score - 1];
  const next = !ticks.world ? "Add World ID to raise this." : count < 3 ? "Add another method to raise this." : "World ID plus two other methods.";

  return (
    <section className="mt-4 rounded-[20px] bg-surface p-4" aria-label="Security meter">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-semibold">Security</p>
        <p className="text-[15px] font-bold text-wave-press" aria-live="polite">
          {level}
        </p>
      </div>
      <div
        className="mt-2.5 flex gap-1.5"
        role="meter"
        aria-label="Security"
        aria-valuemin={0}
        aria-valuemax={SECURITY_LEVELS.length}
        aria-valuenow={score}
        aria-valuetext={level}
      >
        {SECURITY_LEVELS.map((name, index) => (
          <span key={name} className={`h-2 flex-1 rounded-full transition-colors ${index < score ? "bg-wave-deep" : "bg-surface-2"}`} />
        ))}
      </div>
      <div className="mt-2.5 space-y-1 text-sm leading-snug text-ink-2">
        {count === 0 && <p>Tick a method to see your security.</p>}
        {count === 1 && <p>If you lose this method, you lose this wallet. Add a second method.</p>}
        {count > 0 && !ticks.world && (
          <p>With no World ID, the chain does not check that a human owns this wallet. You cannot add World ID later.</p>
        )}
        {count > 0 && <p>{next}</p>}
      </div>
    </section>
  );
}

/** First run: the owner ticks methods. The address follows from them, and nothing goes onchain yet. */
export function CreateWallet() {
  const { state } = useStore();
  const { info, offline } = state;
  const [ticks, setTicks] = useState<Ticks>({ world: false, key: false, passkey: false });
  /** 0 is the first page. It shows no steps, because the ticks set them. */
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<LimitForm | null>(null);
  const [waitOn, setWaitOn] = useState(false);
  const [wait, setWait] = useState(WAITS[0].value);
  const [keys, setKeys] = useState<Keys>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (!info) return null;

  const token = testToken(info);
  const ticked = tickedRows(ticks);
  const ownerRow = ticked[0] ?? null;
  const methods = limitMethods(ticked, info);
  const form = limitForm(methods, draft);
  const pages = setupPages(ticks, form !== null);
  const page = step === 0 ? null : pages[step - 1];
  const limitsValid = token !== undefined && (form === null || formIsValid(form, token));
  const canPasskey = passkeysSupported();
  const isTestWorld = info.world.mode === "dev";
  const worldName = isTestWorld ? "Test identity" : "World ID";
  // A wallet that pays its own gas deploys in the validation prefix, with no room for a setup.
  const oneMethodOnly = !info.gasSponsored;
  const locked = (row: Row) => busy !== null || (oneMethodOnly && !ticks[row] && ticked.length > 0);
  const noPasskeys = canPasskey ? null : "This browser has no passkey support.";

  const toggle = (row: Row) => {
    setError("");
    setTicks({ ...ticks, [row]: !ticks[row] });
  };

  const finish = async (world: PlanOwner | null, rootHint: Hex | null, held: Keys) => {
    if (!token) return;
    setBusy("Creating your wallet…");
    setError("");
    try {
      await saveWallet({ ticks, keys: held, world, rootHint, form, wait: waitOn ? wait : 0, token });
    } catch (cause) {
      setError(errorText(cause, "WAVE could not create the wallet."));
      setBusy(null);
    }
  };

  /** Adds one key, then moves on. A failure keeps the keys that exist. The last page creates the wallet. */
  const addKey = async (row: KeyRow) => {
    setError("");
    let held = keys;
    if (!keys[row]) {
      setBusy(ROW_PROMPT[row]);
      try {
        held = { ...keys, [row]: await makeKey(row) };
        setKeys(held);
      } catch (cause) {
        setError(passkeyErrorText(cause, "The device did not create a passkey."));
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    if (step < pages.length) setStep(step + 1);
    else await finish(null, null, held);
  };

  const onWorldProof = async (proof: WorldProof, raw: unknown) => {
    setError("");
    const request: WorldVerifyRequest = info.world.mode === "idkit" ? { source: "idkit", result: raw } : { source: "dev", proof };
    try {
      const verified = await api.worldVerify(request);
      await finish({ kind: "world", nullifierHash: verified.ownerNullifierHash }, verified.merkleRoot, keys);
    } catch (cause) {
      setError(errorText(cause, "WAVE could not create the wallet."));
    }
  };

  if (page === null) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-10 pt-10">
        <WaveMark className="size-12 text-wave-deep" />
        <h1 className="mt-5 text-[2rem] font-bold leading-tight tracking-tight">Which type do you want?</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Choose how you approve. Any mix works, and you need at least one. The method with the highest rank is the owner.
        </p>

        <fieldset className="mt-5">
          <legend className="sr-only">Approval methods</legend>
          <div className="grid gap-2">
            <TickRow
              icon={Globe}
              title={worldName}
              detail={isTestWorld ? "Test identity. Not a real World ID." : "Approve in World App."}
              checked={ticks.world}
              disabled={locked("world")}
              owner={ownerRow === "world"}
              onToggle={() => toggle("world")}
            />
            <TickRow
              icon={Fingerprint}
              title="Passkey on this device"
              detail={noPasskeys ?? "Face ID or Touch ID."}
              checked={ticks.passkey}
              disabled={locked("passkey") || !canPasskey}
              owner={ownerRow === "passkey"}
              onToggle={() => toggle("passkey")}
            />
            <TickRow
              icon={KeyRound}
              title="Security key"
              detail={noPasskeys ?? "A key that you plug in or tap."}
              checked={ticks.key}
              disabled={locked("key") || !canPasskey}
              owner={ownerRow === "key"}
              onToggle={() => toggle("key")}
            />
          </div>
        </fieldset>

        <SecurityMeter ticks={ticks} />

        <div className="mt-auto pt-5">
          {oneMethodOnly && <p className="mb-3 text-sm text-muted">On this network a new wallet holds one method.</p>}
          <PrimaryButton onClick={() => setStep(1)} disabled={ticked.length === 0}>
            {ticked.length === 0 ? "Tick at least one method" : "Continue"}
          </PrimaryButton>
        </div>
      </div>
    );
  }

  const bar = <StepBar step={step} total={pages.length} onBack={() => setStep(step - 1)} />;
  const failure = error && (
    <div className="mb-3 flex gap-3 rounded-[20px] bg-danger-soft p-4" role="alert">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
      <p className="text-sm leading-snug text-ink">{error}</p>
    </div>
  );

  if (page === "limit" && form && token) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-10 pt-6">
        {bar}
        <h1 className="mt-6 text-[2rem] font-bold leading-tight tracking-tight">Set your limit</h1>
        <div className="mt-5">
          <LimitFields
            form={form}
            methods={methods}
            symbol={token.symbol}
            problems={formProblems(form, token)}
            kindOf={(id) => id as Row}
            onChange={setDraft}
          />
        </div>
        <div className="mt-auto pt-5">
          <PrimaryButton onClick={() => setStep(step + 1)} disabled={!limitsValid}>
            Continue
          </PrimaryButton>
        </div>
      </div>
    );
  }

  if (page === "abilities") {
    const names: Record<Row, string> = { world: worldName, passkey: "Face ID or Touch ID", key: "Security key" };
    return (
      <div className="flex min-h-full flex-col px-6 pb-10 pt-6">
        {bar}
        <h1 className="mt-6 text-[2rem] font-bold leading-tight tracking-tight">What each method can do</h1>
        <div className="mt-5 space-y-3">
          {ticked.map((row) => {
            const Icon = KIND_ICON[row];
            return (
              <section key={row} className="rounded-[24px] bg-surface p-4" aria-label={names[row]}>
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line" aria-hidden>
                    <Icon className="size-5" />
                  </span>
                  <p className="min-w-0 flex-1 font-bold">{names[row]}</p>
                  {row === ownerRow && <span className="shrink-0 rounded-full bg-wave-soft px-2.5 py-1 text-[13px] font-semibold text-wave-press">Owner</span>}
                </div>
                <ul className="mt-3 space-y-2">
                  {abilitiesOf(row, ticked, form).map(({ name, can }) => (
                    <li key={name} className={`flex items-center gap-2.5 text-[15px] ${can ? "font-medium text-ink" : "text-muted"}`}>
                      <span
                        role="checkbox"
                        aria-checked={can}
                        aria-disabled
                        aria-label={name}
                        className={`grid size-5 shrink-0 place-items-center rounded-md ${can ? "bg-wave-deep text-white" : "bg-white ring-1 ring-off"}`}
                      >
                        {can && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
                      </span>
                      <span aria-hidden>{name}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <div className="mt-auto pt-5">
          <PrimaryButton onClick={() => setStep(step + 1)}>Continue</PrimaryButton>
        </div>
      </div>
    );
  }

  if (page === "wait") {
    return (
      <div className="flex min-h-full flex-col px-6 pb-10 pt-6">
        {bar}
        <h1 className="mt-6 text-[2rem] font-bold leading-tight tracking-tight">Risky changes</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">A risky change adds or removes a method, or raises a limit.</p>

        <section className="mt-5 rounded-[20px] bg-surface p-4">
          <div className="flex items-center gap-3">
            <Timer className="size-5 shrink-0 text-ink-2" aria-hidden />
            <p className="min-w-0 flex-1 font-semibold">Wait before risky changes</p>
            <Switch checked={waitOn} onChange={() => setWaitOn(!waitOn)} label="Wait before risky changes" />
          </div>
          {waitOn ? (
            <>
              <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Wait for">
                {WAITS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={wait === item.value}
                    onClick={() => setWait(item.value)}
                    className={`h-10 rounded-full px-4 text-[15px] font-semibold ${
                      wait === item.value ? "bg-wave-deep text-white" : "bg-white text-ink-2 ring-1 ring-line"
                    } ${focusRing}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-sm leading-snug text-muted">
                A risky change waits, and you can cancel it during the wait. When the wait ends, you press Run now.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm leading-snug text-muted">No wait. A stolen owner method can change rules and spend at once.</p>
          )}
        </section>

        <div className="mt-auto pt-5">
          <PrimaryButton onClick={() => setStep(step + 1)}>Continue</PrimaryButton>
        </div>
      </div>
    );
  }

  if (page === "world") {
    return (
      <SetupPanel bar={bar} icon={Globe} title={`Scan with ${worldName}`} body="Your scan is the last step. It creates your wallet.">
        {failure}
        {busy ? (
          <PrimaryButton disabled>{busy}</PrimaryButton>
        ) : (
          <WorldScan
            world={info.world}
            signal={CREATE_SIGNAL}
            label={`Scan with ${worldName}`}
            disabled={offline || !limitsValid}
            onProof={onWorldProof}
          />
        )}
      </SetupPanel>
    );
  }

  const row = page as KeyRow;
  const last = step === pages.length;
  const { title, body, action, Icon } = KEY_PAGE[row];
  const added = keys[row] !== undefined;

  return (
    <SetupPanel bar={bar} icon={Icon} done={added} title={title} body={added ? "This method is ready." : body}>
      {failure}
      <PrimaryButton onClick={() => void addKey(row)} disabled={offline || !limitsValid || busy !== null}>
        {busy ?? (added ? (last ? "Create wallet" : "Continue") : error ? "Try again" : action)}
      </PrimaryButton>
    </SetupPanel>
  );
}

/** The first read of the WAVE server is still running. */
export function Connecting() {
  return (
    <div className="flex h-full flex-col justify-center px-6 text-center" role="status">
      <WaveMark className="mx-auto size-12 text-wave-deep" />
      <p className="mt-4 text-[15px] text-ink-2">Connecting to WAVE…</p>
    </div>
  );
}

/** The WAVE server gave no answer, so this page knows nothing about the wallet. */
export function NotReachable() {
  const { state, refresh } = useStore();
  return (
    <div className="flex h-full flex-col justify-center px-6 text-center">
      <ServerOff className="mx-auto size-10 text-muted" aria-hidden />
      <h1 className="mt-4 text-2xl font-bold tracking-tight">WAVE does not answer</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
        This page cannot reach the WAVE server. Start it with <code className="font-mono text-sm">npm run dev</code> in the
        repo folder, then try again.
      </p>
      {state.error && <p className="mt-2 text-sm text-muted">{state.error}</p>}
      <div className="mt-6">
        <PrimaryButton tone="ghost" onClick={() => void refresh()}>
          <RefreshCw className="size-5" aria-hidden /> Try again
        </PrimaryButton>
      </div>
    </div>
  );
}
