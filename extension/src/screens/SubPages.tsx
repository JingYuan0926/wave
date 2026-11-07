import { useState } from "react";
import { Check, Copy, RotateCcw, ShieldAlert, ShieldCheck, ShieldOff, TriangleAlert, type LucideIcon } from "lucide-react";
import { METHOD_INFO, NFC_NOTE } from "../data";
import { methodName, methodWait } from "../lib/cards";
import {
  CONFIG_DELAY,
  RECOVERY_DELAY,
  anyMethod,
  canUseLimit,
  changeTiming,
  compareRules,
  dailyDirection,
  delayText,
  fitForm,
  formDailyLimit,
  formIsValid,
  formProblems,
  formTiers,
  freePasskeySlot,
  joinDirections,
  leftToday,
  limitChoices,
  limitView,
  liveDaily,
  ownerLimitName,
  ownerName,
  passkeysSupported,
  plainName,
  rankChoices,
  readForm,
  recoveryWait,
  resetLocal,
  sameForm,
  shortHex,
  testToken,
  tokenRules,
  type AccountResponse,
  type LimitChoice,
  type LimitForm,
  type LimitView,
  type TokenInfo,
} from "../lib/wave";
import { DEFAULT_LIMIT, fullMethods } from "../lib/wave/create";
import { useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { BackButton, MethodChip, Meter, PageTitle, PrimaryButton, TopBar, focusRing } from "../components/ui";
import { METHOD_KIND_ICON } from "../components/CardHolder";
import { LimitBox, LimitFields, PerDayField } from "../components/LimitFields";
import { WhitechainSwitchRow } from "../components/WhitechainSwitch";

function NotLoaded({ children }: { children: string }) {
  return <p className="mx-5 mt-5 rounded-[24px] bg-surface p-4 text-sm leading-snug text-ink-2">{children}</p>;
}

/* ---------- Spending limits ---------- */

const kindIn = (choices: LimitChoice[]) => (id: string) => choices.find((item) => item.id === id)?.kind ?? "passkey";

/** A rule with no limit. It says what is true for this wallet, and it shows a picker only if the owner has a choice. */
function EveryField({
  form,
  choices,
  onChange,
}: {
  form: LimitForm;
  choices: LimitChoice[];
  onChange: (next: LimitForm) => void;
}) {
  const full = fullMethods(choices);
  const owner = choices.find((item) => item.owner);
  const picked = choices.find((item) => item.id === form.every);
  return (
    <div>
      <p className="text-[15px] leading-relaxed text-ink-2">
        {picked && !picked.owner
          ? `${picked.name} approves every send. ${owner?.name ?? "The owner method"} can also approve every send.`
          : `One method approves every send: ${picked?.name ?? "the owner method"}.`}
      </p>
      {full.length > 1 && (
        <div className="mt-3">
          <LimitBox
            label="Approve every send with"
            methodLabel="Method for every send"
            method={form.every}
            methods={full}
            kindOf={kindIn(choices)}
            onPick={(id) => onChange({ ...form, every: id })}
          />
        </div>
      )}
    </div>
  );
}

/** The same steps as the Editor in components/settings/rules-editor.tsx, with the boxes of the first-run page. */
function LimitsForm({
  nav,
  account,
  token,
  live,
  chainLimit,
}: {
  nav: Nav;
  account: AccountResponse;
  token: TokenInfo;
  live: LimitForm;
  chainLimit: string;
}) {
  const { info, local, localWallet: wallet } = useStore().state;
  const who = { wallet, local, info };
  const choices = limitChoices(account, who);
  const chainTiers = tokenRules(account, token.address)?.tiers ?? [];
  const [draftForm, setForm] = useState<LimitForm>(() => ({ ...live, amount: live.amount || DEFAULT_LIMIT }));
  const form = fitForm(draftForm, choices);

  const draft = formIsValid(form, token) ? formTiers(form, choices, token) : null;
  const draftLimit = formDailyLimit(form, token);
  const change = draft && !sameForm(form, live, token) ? compareRules(chainTiers, draft, token, account.methods, info?.world) : null;
  const joined = change ? joinDirections(change.direction, dailyDirection(chainLimit, draftLimit)) : "same";
  const how = joined !== "same" ? joined : null;
  const owner = ownerLimitName(account, who);

  const save = () => {
    if (!draft || !how) return;
    const kind = how === "stricter" ? "tighten" : "set-rules";
    nav.openSheet({ type: "saveLimits", how, action: { kind, token: token.address, tiers: draft, dailyLimit: draftLimit } });
  };

  const problems = formProblems(form, token);
  return (
    <>
      <div className="px-5">
        {form.choice === "limit" ? (
          <LimitFields
            form={form}
            methods={choices}
            symbol={token.symbol}
            problems={problems}
            kindOf={kindIn(choices)}
            onChange={setForm}
          />
        ) : (
          <div className="space-y-5">
            <EveryField form={form} choices={choices} onChange={setForm} />
            <PerDayField form={form} symbol={token.symbol} problem={problems.perDay} onChange={setForm} />
          </div>
        )}
        {live.choice === "every" && canUseLimit(choices) && (
          <div className="mt-4">
            <PrimaryButton tone="ghost" onClick={() => setForm({ ...form, choice: form.choice === "every" ? "limit" : "every" })}>
              {form.choice === "every" ? "Add a limit" : "Keep one method"}
            </PrimaryButton>
          </div>
        )}
      </div>

      <div className="mx-5 mt-5">
        <div aria-live="polite">
          {how && (
            <div className={`mb-3 flex gap-3 rounded-[20px] p-4 ${how === "looser" ? "bg-warn-soft" : "bg-wave-mist"}`}>
              {how === "looser" ? (
                <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
              ) : (
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-wave-deep" aria-hidden />
              )}
              <div className="text-sm leading-snug">
                <p className="font-semibold text-ink">
                  {owner} {how === "looser" ? "required" : "not required"}
                </p>
                {how === "looser" ? (
                  account.waitSeconds !== 0 && <p className="mt-0.5 text-ink-2">{changeTiming(account.waitSeconds, CONFIG_DELAY)}</p>
                ) : (
                  <p className="mt-0.5 text-ink-2">Any method can approve this. It applies at once.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <PrimaryButton onClick={save} disabled={!how}>
          Save
        </PrimaryButton>
      </div>
    </>
  );
}

/** A rule that the boxes cannot show, such as custom tiers from the web page. */
function LimitTiers({ view }: { view: LimitView }) {
  return (
    <>
      <p className="mx-5 text-sm leading-snug text-ink-2">
        These rules were set in a way this page cannot edit. Use Settings on the web page.
      </p>
      <ol className="mt-5 space-y-3 px-5">
        {view.rows.map((t) => (
          <li key={t.id} className="rounded-[24px] bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 pt-0.5 text-[17px] font-bold leading-snug">{t.range}</p>
              <div className="flex flex-wrap justify-end gap-1.5">
                {t.approvers.map((a) => (
                  <MethodChip key={a.id} kind={a.kind} label={a.name} />
                ))}
              </div>
            </div>
            <p className="mt-1.5 text-sm text-ink-2">{t.approvers.length > 0 ? t.wait : "No method can approve this amount."}</p>
            {t.cap && (
              <div className="mt-4">
                <p className="text-sm text-ink-2">
                  <span className="font-semibold tabular-nums text-ink">{t.cap.spent}</span> of {t.cap.total} {t.cap.window}
                </p>
                <Meter value={t.cap.value} max={t.cap.max} label="Period cap used" />
              </div>
            )}
          </li>
        ))}
        {view.daily && (
          <li className="rounded-[24px] bg-surface p-4">
            <p className="text-[17px] font-bold leading-snug">Daily limit</p>
            <p className="mt-1.5 text-sm text-ink-2">
              {view.daily.left} left{view.daily.resets ? ` · resets ${view.daily.resets}` : ""}
            </p>
            <div className="mt-4">
              <p className="text-sm text-ink-2">
                <span className="font-semibold tabular-nums text-ink">{view.daily.spent}</span> of {view.daily.total}{" "}
                {view.daily.window}
              </p>
              <Meter value={view.daily.value} max={view.daily.max} label="Daily limit used" />
            </div>
          </li>
        )}
      </ol>
    </>
  );
}

export function SpendingLimits({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const { account, info, local, localWallet: wallet } = state;
  const now = useNow(60_000);
  const token = testToken(info);
  const top = <TopBar left={<BackButton onClick={nav.back} />} />;

  if (!account || !token) {
    return (
      <>
        {top}
        <PageTitle>Your spending limits</PageTitle>
        <NotLoaded>Your limits have not loaded yet.</NotLoaded>
      </>
    );
  }

  const who = { wallet, local, info };
  const rule = tokenRules(account, token.address);
  const chainTiers = rule?.tiers ?? [];
  const daily = liveDaily(rule?.daily, Math.floor(now / 1000));
  const chainLimit = daily?.limit ?? "0";
  const live = readForm(chainTiers, limitChoices(account, who), token, chainLimit);
  const view = limitView(account, token, who);
  const queued = account.pending.filter(
    (action) => action.status !== "stale" && action.decoded.title === `Change ${token.symbol} rules`,
  );
  // Counters change with each poll. A new key means that the limits or the queue changed, so the form reads them again.
  const formKey = JSON.stringify([
    chainLimit,
    chainTiers.map(({ upTo, cap, delay, period, methods, small }) => [upTo, cap, delay, period, methods, small]),
    account.methods.length,
    queued.length,
  ]);

  return (
    <>
      {top}
      <PageTitle sub={live ? undefined : "Each amount has its own approval method and timing."}>Your spending limits</PageTitle>

      {queued.length > 0 && (
        <div className="mx-5 mb-5 flex gap-3 rounded-[20px] bg-warn-soft p-4" role="status">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <p className="text-sm leading-snug text-ink-2">
            <span className="font-semibold text-ink">A limit change is waiting.</span> Your limit stays the same until it runs. See it in
            Payments.
          </p>
        </div>
      )}

      {live ? <LimitsForm key={formKey} nav={nav} account={account} token={token} live={live} chainLimit={chainLimit} /> : <LimitTiers view={view} />}

      <div className="mx-5 mt-5 space-y-2 rounded-[20px] bg-wave-mist p-4 text-sm leading-snug text-ink-2">
        <p>
          <span className="font-semibold text-ink">To lower a limit,</span> use any method. It applies at once.
        </p>
        <p>
          <span className="font-semibold text-ink">To raise a limit,</span> use {ownerLimitName(account, who)}.{" "}
          {changeTiming(account.waitSeconds, CONFIG_DELAY)}
        </p>
        {view.hasCap && <p>When a cap is used up, the next tier applies. With no next tier, the send stops.</p>}
        <p>{daily ? `The daily limit stops every method and every tier. ${leftToday(daily, token)}.` : "This token has no daily limit."}</p>
      </div>
    </>
  );
}

/* ---------- Approval methods ---------- */

export function Methods({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const { account, info, local, localWallet: wallet, offline } = state;
  const now = useNow(60_000);
  const others = state.cards.filter((c) => !c.owner && !c.queued);
  const backups = others.filter((c) => c.backup !== "synced").length;
  const hasSynced = others.some((c) => c.backup === "synced");
  const ready = account?.recovery.available ?? false;
  const slot = account ? freePasskeySlot(account.methods, account.pending) : null;
  const canAdd = !!slot && !offline && passkeysSupported();

  const addDetail = !slot
    ? "All three passkey slots are in use or queued"
    : offline
      ? "The chain does not answer, so nothing can be added"
      : !passkeysSupported()
        ? "This browser cannot make a passkey"
        : "Face ID, Touch ID or a security key";

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle sub="Each method is a card in your wallet's holder. No seed phrase, no private key.">Approval methods</PageTitle>

      {!account && <NotLoaded>Your methods have not loaded yet.</NotLoaded>}

      {account && (
        <ul className="space-y-3 px-5">
          {state.cards.map((card) => {
            const wait = methodWait(card, now);
            return (
              <MethodRow
                key={card.id}
                icon={METHOD_KIND_ICON[card.kind]}
                title={methodName(card)}
                detail={card.subtitle ?? METHOD_INFO[card.kind].approves}
                badge={
                  card.owner
                    ? { text: "Owner", tone: "accent" }
                    : wait
                      ? { text: wait, tone: "warn" }
                      : { text: "Active", tone: "positive" }
                }
              />
            );
          })}
          <MethodRow
            icon={METHOD_KIND_ICON.passkey}
            title="New passkey"
            detail={addDetail}
            action={{ label: "Add", disabled: !canAdd, onClick: () => nav.openSheet({ type: "createCard", kind: "passkey" }) }}
          />
          <MethodRow
            icon={METHOD_KIND_ICON.nfc}
            title={METHOD_INFO.nfc.name}
            detail={NFC_NOTE}
            action={{ label: "Add", onClick: () => nav.openSheet({ type: "createCard", kind: "nfc" }) }}
          />
        </ul>
      )}

      {account && (
        <section className="mx-5 mt-5 rounded-[24px] border border-line p-4" aria-labelledby="recovery-title">
          <div className="flex items-center gap-2">
            {ready ? <ShieldCheck className="size-5 text-positive" aria-hidden /> : <ShieldOff className="size-5 text-warn" aria-hidden />}
            <h2 id="recovery-title" className="text-[17px] font-bold">
              {ready ? "Recovery is ready" : "Recovery isn't ready"}
            </h2>
          </div>
          <p className="mt-2 text-sm leading-snug text-ink-2">
            If you lose {ownerName(account, { wallet, local, info })}, two other methods can hand the wallet to a new owner{" "}
            {recoveryWait(account)}. You have {Math.min(backups, 2)} of 2.
            {hasSynced && " A synced passkey cannot run a recovery."}
          </p>
          <div className="mt-3 flex gap-1.5" aria-hidden>
            {[0, 1].map((i) => (
              <span key={i} className={`h-2 flex-1 rounded-full ${i < backups ? "bg-wave-deep" : "bg-surface-2"}`} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function MethodRow({
  icon: Icon,
  title,
  detail,
  badge,
  action,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  badge?: { text: string; tone: "accent" | "positive" | "warn" };
  action?: { label: string; onClick?: () => void; disabled?: boolean };
}) {
  return (
    <li className="flex items-center gap-4 rounded-[24px] bg-surface p-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white text-ink ring-1 ring-line" aria-hidden>
        <Icon className="size-[22px]" strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold">{title}</p>
        <p className="text-sm leading-snug text-muted">{detail}</p>
      </div>
      {badge && (
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold ${
            badge.tone === "accent" ? "bg-wave text-ink" : badge.tone === "warn" ? "bg-warn-soft text-warn" : "bg-wave-soft text-positive"
          }`}
        >
          {badge.text}
        </span>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className={`h-10 shrink-0 rounded-full px-4 text-[15px] font-semibold ${
            action.disabled ? "bg-warn-soft text-warn" : "bg-wave-deep text-white hover:bg-wave-press"
          } ${focusRing}`}
        >
          {action.label}
        </button>
      )}
    </li>
  );
}

/* ---------- Account details ---------- */

export function AccountDetails({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const { account, info, local, localWallet: wallet } = state;
  const address = state.wallet.address;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const chainRows: [string, string][] = account
    ? [
        ["Status", account.deployed ? "Deployed" : "Your first transaction deploys it"],
        [
          "Validators",
          rankChoices(anyMethod(account.methods), wallet, local, info)
            .map(({ view }) => `${plainName(view, wallet, local, info?.world)} · ${shortHex(view.validator)}`)
            .join("\n"),
        ],
        ["Wait for changes", delayText(CONFIG_DELAY, account.demoDelay)],
        ["Recovery delay", delayText(RECOVERY_DELAY, account.demoDelay)],
      ]
    : [];

  const rows: [string, string][] = [
    ["Network", !info ? "--" : info.network === "local" ? "WAVE local network" : "WAVE devnet"],
    ["Chain ID", info ? String(info.chainId) : "--"],
    ["Account type", "EIP-8141 frame account"],
    ...chainRows,
  ];

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle>Account details</PageTitle>

      <div className="mx-5 rounded-[24px] bg-surface p-4">
        <p className="text-sm text-muted">Your address</p>
        <p className="mt-1 break-all font-mono text-[15px] leading-relaxed">{address}</p>
        <button
          type="button"
          onClick={copy}
          className={`mt-3 inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[15px] font-semibold ring-1 ring-line hover:bg-surface-2 ${focusRing}`}
        >
          {copied ? <Check className="size-4 text-positive" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
        </button>
      </div>

      <div className="mx-5 mt-4 flex items-center gap-3 rounded-[20px] bg-wave-mist p-4">
        <ShieldCheck className="size-5 shrink-0 text-wave-deep" aria-hidden />
        <p className="text-sm font-semibold">No seed phrase. No private key to leak.</p>
      </div>

      <dl className="mx-5 mt-4 divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-3.5">
            <dt className="text-[15px] text-muted">{k}</dt>
            <dd className="whitespace-pre-line text-right text-[15px] font-semibold">{v}</dd>
          </div>
        ))}
      </dl>

      <WhitechainSwitchRow />

      <StartOver onDone={nav.back} />
    </>
  );
}

/** Returns to the first-run screen, so a tester can run the create flow again. */
function StartOver({ onDone }: { onDone: () => void }) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <div className="mx-5 mt-4">
        <PrimaryButton tone="ghost" onClick={() => setAsking(true)}>
          <RotateCcw className="size-5" aria-hidden /> Start over
        </PrimaryButton>
      </div>
    );
  }
  return (
    <div className="mx-5 mt-4 rounded-[24px] bg-warn-soft p-4">
      <p className="text-sm leading-snug text-ink-2">
        This browser forgets this wallet, its test identity and its passkey IDs. Then you see the first page again. With a test
        identity, you cannot get back into this wallet.
      </p>
      <div className="mt-3 space-y-2">
        <PrimaryButton
          onClick={() => {
            onDone();
            resetLocal();
          }}
        >
          Forget this wallet
        </PrimaryButton>
        <PrimaryButton tone="ghost" onClick={() => setAsking(false)}>
          Keep it
        </PrimaryButton>
      </div>
    </div>
  );
}
