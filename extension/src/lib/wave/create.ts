import { api } from "@/lib/api-client";
import type { Hex, InfoResponse, PlanOwner, TokenInfo, WalletPlan } from "@/lib/api-types";
import { defaultForm, fitForm, formSends, type LimitForm, type LimitMethod } from "@/lib/ui/limits";

export { canUseLimit, formProblems, fullMethods, lowerChoices, pickLower, pickUpper } from "@/lib/ui/limits";
export type { LimitForm, LimitMethod } from "@/lib/ui/limits";

import { savePasskey, setWallet, type PasskeyName } from "@/lib/ui/local";
import { enrolPasskey, type EnrolledPasskey } from "@/lib/ui/passkey";
import { methodLabel } from "@/lib/ui/rules";

/** The first-run rules from components/create-wallet.tsx, with no UI. */

export type Row = "world" | "key" | "passkey";
export type KeyRow = Exclude<Row, "world">;
export type Ticks = Record<Row, boolean>;
export type Keys = Partial<Record<KeyRow, EnrolledPasskey>>;

/** Highest rank first. The first ticked row is the owner method. */
const RANK: Row[] = ["world", "key", "passkey"];
const KEY_ROWS: KeyRow[] = ["key", "passkey"];
/** The usual first limit for the test token. */
export const DEFAULT_LIMIT = "100";
const HOUR = 3600;

/** The waits a person can pick. With the wait off, the value is 0, which is no wait. */
export const WAITS = [
  { value: 5, label: "5 sec" },
  { value: 10, label: "10 sec" },
  { value: 15, label: "15 sec" },
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: HOUR, label: "1 hour" },
  { value: 24 * HOUR, label: "24 hours" },
  { value: 48 * HOUR, label: "48 hours" },
];

const ROW_NAME: Record<KeyRow, PasskeyName> = { key: "security-key", passkey: "passkey" };
const ROW_ATTACHMENT = { key: "cross-platform", passkey: "platform" } as const;

export const ROW_PROMPT: Record<KeyRow, string> = {
  key: "Waiting for your security key…",
  passkey: "Waiting for Face ID / Touch ID…",
};

export const tickedRows = (ticks: Ticks) => RANK.filter((row) => ticks[row]);

export const SECURITY_LEVELS = ["Weak", "Fair", "Good", "Strong"] as const;

/** A guide from the ticks only, from 0 to 4. World ID counts double, because only it proves a human owner. */
export const securityScore = (ticks: Ticks): number => (ticks.world ? 2 : 0) + (ticks.key ? 1 : 0) + (ticks.passkey ? 1 : 0);

/** A page after the first. Each ticked method has its own page. */
export type SetupPage = "limit" | "abilities" | "wait" | Row;

/** The ticks set the pages, so the step count follows them. A World ID scan goes last, because it creates the wallet. */
export function setupPages(ticks: Ticks, hasLimit: boolean): SetupPage[] {
  const devices = (["passkey", "key"] as const).filter((row) => ticks[row]);
  return [...(hasLimit ? (["limit"] as const) : []), "abilities", "wait", ...devices, ...(ticks.world ? (["world"] as const) : [])];
}

/**
 * What one method can do, from the rules in WavePolicy. The contract fixes the owner actions, so
 * this is a true list and not a choice. The limit form sets only the two send lines.
 */
export function abilitiesOf(row: Row, ticked: Row[], form: LimitForm | null): { name: string; can: boolean }[] {
  const owner = ticked[0] === row;
  const sends = form
    ? [
        { name: "Send up to your limit", can: owner || form.lower === row },
        { name: "Send over your limit", can: owner || form.upper === row },
      ]
    : [{ name: "Send any amount", can: true }];
  return [
    ...sends,
    { name: "Lower limits", can: true },
    { name: "Stop an agent", can: true },
    { name: "Raise limits", can: owner },
    { name: "Add or remove methods", can: owner },
    { name: "Create agent wallets", can: true },
  ];
}

export function rowNames(info: InfoResponse): Record<Row, string> {
  return {
    world: methodLabel({ kind: "world" }, info.world),
    key: "Security key",
    passkey: "Passkey on this device",
  };
}

/** The browser reports a synced passkey only after it makes one, so the form assumes the weak case. */
export function limitMethods(ticked: Row[], info: InfoResponse): LimitMethod[] {
  const names = rowNames(info);
  return ticked.map((row, index) => {
    const full = index === 0 || row === "key";
    return {
      id: row,
      name: names[row],
      owner: index === 0,
      full,
      note: full ? undefined : "A passkey on this device can sync, so it needs a limit.",
    };
  });
}

/** The person's limits, fitted to the ticked methods. One method needs no limit. */
export const limitForm = (methods: LimitMethod[], draft: LimitForm | null): LimitForm | null =>
  methods.length > 1 ? fitForm(draft ?? defaultForm(methods, DEFAULT_LIMIT), methods) : null;

export function makeKey(row: KeyRow): Promise<EnrolledPasskey> {
  // The WebAuthn user ID comes from this name. Two credentials with one user ID replace each other.
  const tag = crypto.randomUUID().slice(0, 8);
  return enrolPasskey(`WAVE ${tag} ${ROW_NAME[row]}`, ROW_ATTACHMENT[row]);
}

const facts = ({ publicKey, backupEligible }: EnrolledPasskey) => ({ publicKey, backupEligible });

/** Turns the ticks into a wallet address and stores it. This step sends nothing to the chain. */
export async function saveWallet(input: {
  ticks: Ticks;
  keys: Keys;
  world: PlanOwner | null;
  rootHint: Hex | null;
  form: LimitForm | null;
  wait: number;
  token: TokenInfo;
}): Promise<void> {
  const { ticks, keys, world, rootHint, form, wait, token } = input;
  const ownerRow = tickedRows(ticks)[0];
  const extraRows = KEY_ROWS.filter((row) => ticks[row] && row !== ownerRow);
  const held = (row: KeyRow) => keys[row] as EnrolledPasskey;
  const owner: PlanOwner = world ?? { kind: "passkey", ...facts(held(ownerRow as KeyRow)) };
  const indexOf = (id: string) => (id === ownerRow ? 0 : extraRows.indexOf(id as KeyRow) + 1);
  const plan: WalletPlan = {
    owner,
    extras: extraRows.map((row) => facts(held(row))),
    wait,
    ...(form ? { sends: formSends(form, indexOf, token) } : {}),
  };
  const planned = await api.walletPlan(plan);
  if (planned.ownerSlot !== null) {
    savePasskey(planned.address, planned.ownerSlot, {
      credentialId: held(ownerRow as KeyRow).credentialId,
      name: ROW_NAME[ownerRow as KeyRow],
    });
  }
  extraRows.forEach((row, index) => {
    savePasskey(planned.address, planned.extraSlots[index], {
      credentialId: held(row).credentialId,
      name: ROW_NAME[row],
    });
  });
  setWallet({ address: planned.address, plan, rootHint });
}
