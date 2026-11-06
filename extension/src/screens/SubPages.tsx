import { useState } from "react";
import { Check, Copy, ShieldCheck, ShieldOff, type LucideIcon } from "lucide-react";
import { METHOD_INFO, RULES, type MethodKind, type Token } from "../data";
import { fmtToken } from "../lib/format";
import { hoursLeft, useNow, useStore } from "../store";
import type { Nav } from "../nav";
import { BackButton, MethodChip, PageTitle, TopBar, focusRing } from "../components/ui";
import { METHOD_KIND_ICON } from "../components/CardHolder";

/* ---------- Spending limits ---------- */

export function SpendingLimits({ nav }: { nav: Nav }) {
  const [token, setToken] = useState<Token>("USDC");
  const tiers = RULES[token];

  const rangeLabel = (i: number) => {
    const t = tiers[i];
    const prev = tiers[i - 1]?.upTo;
    if (i === 0 && t.upTo !== null) return `Under ${fmtToken(t.upTo, token)}`;
    if (t.upTo === null) return `Over ${fmtToken(prev ?? 0, token)}`;
    return `${fmtToken(prev ?? 0, token).split(" ")[0]} to ${fmtToken(t.upTo, token)}`;
  };

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle sub="Each amount has its own approval method and timing.">Your spending limits</PageTitle>

      <div className="mx-5 inline-flex rounded-full bg-surface p-1" role="group" aria-label="Token">
        {(["USDC", "ETH"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={token === t}
            onClick={() => setToken(t)}
            className={`h-10 rounded-full px-5 text-[15px] font-semibold transition-colors ${
              token === t ? "bg-white text-ink shadow-sm" : "text-ink-2 hover:text-ink"
            } ${focusRing}`}
          >
            {t}
          </button>
        ))}
      </div>

      <ol className="mt-5 space-y-3 px-5">
        {tiers.map((t, i) => {
          const pct = t.cap ? Math.min(100, (t.cap.used / t.cap.amount) * 100) : 0;
          return (
            <li key={i} className="rounded-[24px] bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[17px] font-bold">{rangeLabel(i)}</p>
                <MethodChip method={t.method} />
              </div>
              <p className="mt-1.5 text-sm text-ink-2">
                {t.delayHours === 0 ? "Runs at once" : `Waits ${t.delayHours} hours · you can cancel`}
              </p>
              {t.cap && (
                <div className="mt-4">
                  <p className="text-sm text-ink-2">
                    <span className="font-semibold tabular-nums text-ink">{fmtToken(t.cap.used, token)}</span> of{" "}
                    {fmtToken(t.cap.amount, token)} {t.cap.per === "day" ? "today" : "this week"}
                  </p>
                  <div
                    className="mt-2 h-2 overflow-hidden rounded-full bg-white"
                    role="progressbar"
                    aria-label="Period cap used"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="h-full rounded-full bg-wave-deep" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mx-5 mt-5 space-y-2 rounded-[20px] bg-wave-mist p-4 text-sm leading-snug text-ink-2">
        <p>
          <span className="font-semibold text-ink">Stricter rules apply at once</span> with any method.
        </p>
        <p>
          <span className="font-semibold text-ink">Looser rules need World ID</span> and wait 48 hours.
        </p>
        <p>When a cap is used up, the next tier's rule applies.</p>
      </div>
    </>
  );
}

/* ---------- Approval methods ---------- */

export function Methods({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const now = useNow(60_000);
  const byKind = new Map(state.cards.map((c) => [c.kind, c]));
  const backups = state.cards.filter((c) => c.kind !== "worldid" && c.activeAt <= now).length;
  const ready = backups >= 2;

  const DETAIL: Record<MethodKind, string> = {
    worldid: "Owner · Orb-verified human",
    faceid: "This device · device-bound",
    passkey: "Use a different device for real independence",
    nfc: "Tap a signing card to approve",
  };

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle sub="Each method is a card in your wallet's holder. No seed phrase, no private key.">Approval methods</PageTitle>

      <ul className="space-y-3 px-5">
        {(["worldid", "faceid", "passkey", "nfc"] as const).map((kind) => {
          const card = byKind.get(kind);
          const hours = card ? hoursLeft(card, now) : 0;
          return (
            <MethodRow
              key={kind}
              icon={METHOD_KIND_ICON[kind]}
              title={METHOD_INFO[kind].name}
              detail={DETAIL[kind]}
              badge={
                !card
                  ? undefined
                  : kind === "worldid"
                    ? { text: "Owner", tone: "accent" }
                    : hours > 0
                      ? { text: `Active in ${hours}h`, tone: "warn" }
                      : { text: "Active", tone: "positive" }
              }
              action={
                card || (kind !== "passkey" && kind !== "nfc")
                  ? undefined
                  : { label: "Add", onClick: () => nav.openSheet({ type: "createCard", kind }) }
              }
            />
          );
        })}
      </ul>

      <section className="mx-5 mt-5 rounded-[24px] border border-line p-4" aria-labelledby="recovery-title">
        <div className="flex items-center gap-2">
          {ready ? <ShieldCheck className="size-5 text-positive" aria-hidden /> : <ShieldOff className="size-5 text-warn" aria-hidden />}
          <h2 id="recovery-title" className="text-[17px] font-bold">
            {ready ? "Recovery is ready" : "Recovery isn't ready"}
          </h2>
        </div>
        <p className="mt-2 text-sm leading-snug text-ink-2">
          If you lose World ID, two other methods can hand the wallet to a new owner after 7 days. You have{" "}
          {Math.min(backups, 2)} of 2.
        </p>
        <div className="mt-3 flex gap-1.5" aria-hidden>
          {[0, 1].map((i) => (
            <span key={i} className={`h-2 flex-1 rounded-full ${i < backups ? "bg-wave-deep" : "bg-surface-2"}`} />
          ))}
        </div>
      </section>
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
            action.disabled ? "bg-warn-soft text-warn" : "bg-wave-deep text-white hover:bg-[#222626]"
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
  const now = useNow(60_000);
  const account = state.wallet;
  const activeMethods = state.cards.filter((c) => c.activeAt <= now).map((c) => METHOD_INFO[c.kind].name);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const rows: [string, string][] = [
    ["Network", "WAVE devnet · chain 1337"],
    ["Account type", "EIP-8141 frame account"],
    ["Validators", activeMethods.join(", ")],
    ["Recovery delay", "7 days"],
  ];

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle>Account details</PageTitle>

      <div className="mx-5 rounded-[24px] bg-surface p-4">
        <p className="text-sm text-muted">Your address</p>
        <p className="mt-1 break-all font-mono text-[15px] leading-relaxed">{account.address}</p>
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
            <dd className="text-right text-[15px] font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
