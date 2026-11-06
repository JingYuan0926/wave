import { useState } from "react";
import { Check, Copy, ExternalLink, ShieldCheck, type LucideIcon } from "lucide-react";
import { METHOD_INFO, NOT_ON_WHITECHAIN, TOKEN_ORDER, type MethodKind, type Token } from "../data";
import { fmtToken } from "../lib/format";
import { NETWORK_NAME, WC, addressUrl, tokenInfo } from "../lib/wc/config";
import { fromUnits, type ChainTier } from "../lib/wc/wallet";
import { useStore } from "../store";
import type { Nav } from "../nav";
import { BackButton, MethodChip, Meter, PageTitle, TokenIcon, TopBar, focusRing } from "../components/ui";
import { METHOD_KIND_ICON } from "../components/CardHolder";

const DAY = 86_400;
const MAX_U96 = (1n << 96n) - 1n;

function periodLabel(seconds: number) {
  if (seconds === DAY) return "today";
  if (seconds === 7 * DAY) return "this week";
  if (seconds % DAY === 0) return `per ${seconds / DAY} days`;
  return `per ${Math.round(seconds / 3600)} hours`;
}

function delayLabel(seconds: number) {
  if (seconds === 0) return "Runs at once";
  const h = Math.round(seconds / 3600);
  return h >= 1 ? `Waits ${h} hours · you can cancel` : `Waits ${Math.round(seconds / 60)} minutes · you can cancel`;
}

/* ---------- Spending limits ---------- */

export function SpendingLimits({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const [token, setToken] = useState<Token>("USDT");
  const decimals = tokenInfo(token)?.decimals ?? 6;
  const tiers: ChainTier[] = state.tiers[token] ?? [];
  const units = (n: bigint) => fromUnits(n, decimals);

  const rangeLabel = (i: number) => {
    const t = tiers[i];
    const prev = tiers[i - 1]?.upTo;
    if (t.upTo >= MAX_U96) return `Over ${fmtToken(units(prev ?? 0n), token)}`;
    if (i === 0) return `Up to ${fmtToken(units(t.upTo), token)}`;
    return `${fmtToken(units(prev ?? 0n), token).split(" ")[0]} to ${fmtToken(units(t.upTo), token)}`;
  };

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle sub={`Each amount has its own timing. Read from your wallet on ${NETWORK_NAME}.`}>Your spending limits</PageTitle>

      <div className="mx-5 inline-flex rounded-full bg-surface p-1" role="group" aria-label="Token">
        {TOKEN_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={token === t}
            onClick={() => setToken(t)}
            className={`flex h-10 items-center gap-2 whitespace-nowrap rounded-full pl-2 pr-4 text-[15px] font-semibold transition-colors ${
              token === t ? "bg-white text-ink shadow-sm" : "text-ink-2 hover:text-ink"
            } ${focusRing}`}
          >
            <TokenIcon token={t} size="sm" />
            {t}
          </button>
        ))}
      </div>

      {tiers.length === 0 ? (
        <p className="mx-5 mt-5 text-[15px] text-muted">Loading your rules…</p>
      ) : (
        <ol className="mt-5 space-y-3 px-5">
          {tiers.map((t, i) => (
            <li key={i} className="rounded-[24px] bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 pt-0.5 text-[17px] font-bold leading-snug">{rangeLabel(i)}</p>
                <MethodChip method="faceid" />
              </div>
              <p className="mt-1.5 text-sm text-ink-2">{delayLabel(t.delay)}</p>
              {t.cap > 0n && (
                <div className="mt-4">
                  <p className="text-sm text-ink-2">
                    <span className="font-semibold tabular-nums text-ink">{fmtToken(units(t.spent), token)}</span> of{" "}
                    {fmtToken(units(t.cap), token)} {periodLabel(t.period)}
                  </p>
                  <Meter value={units(t.spent)} max={units(t.cap)} label="Period cap used" />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="mx-5 mt-5 space-y-2 rounded-[20px] bg-wave-mist p-4 text-sm leading-snug text-ink-2">
        <p>
          <span className="font-semibold text-ink">Stricter rules apply at once.</span>
        </p>
        <p>
          <span className="font-semibold text-ink">Looser rules need your passkey</span> and wait 48 hours.
        </p>
        <p>When a cap is used up, the next tier's rule applies.</p>
      </div>
    </>
  );
}

/* ---------- Approval methods ---------- */

export function Methods({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const has = new Set(state.cards.map((c) => c.kind));

  const DETAIL: Record<MethodKind, string> = {
    faceid: "Owner · Face ID, Touch ID or Windows Hello on this device",
    worldid: "Orb-verified human · WAVE frame network",
    passkey: "A passkey on another device",
    nfc: "Tap a signing card to approve",
  };

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle sub="Each method is a card in your wallet's holder. No seed phrase, no private key.">Approval methods</PageTitle>

      <ul className="space-y-3 px-5">
        {(["faceid", "worldid", "passkey", "nfc"] as const).map((kind) => (
          <MethodRow
            key={kind}
            icon={METHOD_KIND_ICON[kind]}
            title={METHOD_INFO[kind].name}
            detail={DETAIL[kind]}
            badge={
              has.has(kind)
                ? { text: "Owner", tone: "accent" }
                : NOT_ON_WHITECHAIN.includes(kind)
                  ? { text: "Not on Whitechain yet", tone: "muted" }
                  : undefined
            }
          />
        ))}
      </ul>

      <section className="mx-5 mt-5 rounded-[24px] border border-line p-4" aria-labelledby="recovery-title">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-wave-deep" aria-hidden />
          <h2 id="recovery-title" className="text-[17px] font-bold">
            Keep your passkey safe
          </h2>
        </div>
        <p className="mt-2 text-sm leading-snug text-ink-2">
          On Whitechain your passkey is the wallet's only method. A synced passkey (iCloud Keychain or Google Password
          Manager) survives a lost phone. Recovery with other methods comes with more methods.
        </p>
      </section>
    </>
  );
}

function MethodRow({
  icon: Icon,
  title,
  detail,
  badge,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  badge?: { text: string; tone: "accent" | "muted" };
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
          className={`max-w-[7.5rem] shrink-0 rounded-full px-2.5 py-1 text-center text-[12px] font-semibold leading-tight ${
            badge.tone === "accent" ? "bg-wave text-ink" : "bg-white text-muted ring-1 ring-line"
          }`}
        >
          {badge.text}
        </span>
      )}
    </li>
  );
}

/* ---------- Account details ---------- */

export function AccountDetails({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const account = state.wallet;
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
    ["Network", `${NETWORK_NAME} · chain 1874`],
    ["Account type", "ERC-4337 smart account"],
    ["Status", state.deployed ? "Set up onchain" : "Sets up with the first payment"],
    ["Approves with", state.passkey?.backupEligible ? "Synced passkey (owner)" : "Device passkey (owner)"],
    ["Gas", "Paid by WAVE in WBT"],
    ["EntryPoint", "v0.7"],
  ];

  return (
    <>
      <TopBar left={<BackButton onClick={nav.back} />} />
      <PageTitle>Account details</PageTitle>

      <div className="mx-5 rounded-[24px] bg-surface p-4">
        <p className="text-sm text-muted">Your address</p>
        <p className="mt-1 break-all font-mono text-[15px] leading-relaxed">{account.address || "…"}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={copy}
            disabled={!account.address}
            className={`inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[15px] font-semibold ring-1 ring-line hover:bg-surface-2 ${focusRing}`}
          >
            {copied ? <Check className="size-4 text-positive" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            <span aria-live="polite">{copied ? "Copied" : "Copy address"}</span>
          </button>
          {account.address && (
            <a
              href={addressUrl(account.address)}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[15px] font-semibold ring-1 ring-line hover:bg-surface-2 ${focusRing}`}
            >
              Explorer <ExternalLink className="size-4" aria-hidden />
            </a>
          )}
        </div>
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
      {WC && (
        <p className="mx-5 mt-2 break-all text-xs leading-relaxed text-muted">
          Factory {WC.factory} · Paymaster {WC.paymaster}
        </p>
      )}
    </>
  );
}
