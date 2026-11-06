"use client";

import { Fingerprint, Globe, KeyRound, Nfc } from "lucide-react";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import {
  CREATE_SIGNAL,
  type Hex,
  type PlanOwner,
  type WalletPlan,
  type WorldProof,
  type WorldVerifyRequest,
} from "@/lib/api-types";
import { cn } from "@/lib/ui/cn";
import {
  defaultForm,
  fitForm,
  formIsValid,
  formSends,
  type LimitForm,
  type LimitMethod,
} from "@/lib/ui/limits";
import { savePasskey, setWallet, type PasskeyName } from "@/lib/ui/local";
import { enrolPasskey, passkeysSupported, type EnrolledPasskey } from "@/lib/ui/passkey";
import { methodLabel } from "@/lib/ui/rules";
import { LimitChoices } from "./limit-choices";
import { Badge, Button, Card, Notice, SelectField, Skeleton } from "./ui";
import { useWallet } from "./wallet-provider";
import { WorldScan } from "./world-scan";

type Row = "world" | "key" | "passkey";
/** The rows that make a WebAuthn credential. */
type KeyRow = Exclude<Row, "world">;

/** Highest rank first. The first ticked row is the owner method. */
const RANK: Row[] = ["world", "key", "passkey"];
const KEY_ROWS: KeyRow[] = ["key", "passkey"];
const DEFAULT_LIMIT = "100";

const HOUR = 3600;
/** The chosen waits. No tick means a wait of 0 seconds, which is no wait. */
const WAITS = [
  { value: 5, label: "5 seconds (demo)" },
  { value: 10, label: "10 seconds (demo)" },
  { value: 15, label: "15 seconds (demo)" },
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
  { value: HOUR, label: "1 hour" },
  { value: 24 * HOUR, label: "24 hours" },
  { value: 48 * HOUR, label: "48 hours" },
];

const ROW_NAME: Record<KeyRow, PasskeyName> = { key: "security-key", passkey: "passkey" };
const ROW_ATTACHMENT = { key: "cross-platform", passkey: "platform" } as const;
const ROW_PROMPT: Record<KeyRow, string> = {
  key: "Waiting for your security key…",
  passkey: "Waiting for Face ID / Touch ID…",
};

type Ticks = Record<Row, boolean>;
type Keys = Partial<Record<KeyRow, EnrolledPasskey>>;

const facts = ({ publicKey, backupEligible }: EnrolledPasskey) => ({ publicKey, backupEligible });

function MethodRow({
  icon,
  title,
  detail,
  checked,
  disabled,
  owner,
  onChange,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  owner?: boolean;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <label className={cn("flex min-h-11 items-start gap-3 p-3", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className="mt-0.5 size-5 shrink-0 accent-current"
        />
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center text-muted-foreground",
            disabled && "opacity-60",
          )}
        >
          {icon}
        </span>
        <span className={cn("min-w-0 flex-1", disabled && "opacity-60")}>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-sm text-muted-foreground">{detail}</span>
        </span>
        {owner ? (
          <Badge tone="success" className="shrink-0">
            Owner method
          </Badge>
        ) : null}
      </label>
      {children ? <div className="flex flex-col gap-2 px-3 pb-3 sm:ps-12">{children}</div> : null}
    </li>
  );
}

export function CreateWallet() {
  const { info, offline } = useWallet();
  const [ticks, setTicks] = useState<Ticks>({ world: false, key: false, passkey: false });
  const [draftForm, setForm] = useState<LimitForm | null>(null);
  const [keys, setKeys] = useState<Keys>({});
  const [waitOn, setWaitOn] = useState(false);
  const [wait, setWait] = useState(WAITS[1].value);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!info) {
    return (
      <Card>
        <Skeleton className="h-72" />
      </Card>
    );
  }

  const token = info.tokens.find((item) => item.isTest);
  const ticked = RANK.filter((row) => ticks[row]);
  const ownerRow = ticked[0] ?? null;
  const extraRows = KEY_ROWS.filter((row) => ticks[row] && row !== ownerRow);
  const neededKeys = KEY_ROWS.filter((row) => ticks[row] && !keys[row]);
  const rowName: Record<Row, string> = {
    world: methodLabel({ kind: "world" }, info.world),
    key: "Security key",
    passkey: "Passkey on this device",
  };
  // The browser reports a synced passkey only after it makes one, so the form assumes the weak case.
  const limitMethods: LimitMethod[] = ticked.map((row) => ({
    id: row,
    name: rowName[row],
    owner: row === ownerRow,
    full: row === ownerRow || row === "key",
    note: row === ownerRow || row === "key" ? undefined : "A passkey on this device can sync, so it needs a limit.",
  }));
  const form =
    ticked.length > 1 ? fitForm(draftForm ?? defaultForm(limitMethods, DEFAULT_LIMIT), limitMethods) : null;
  const limitsValid = token !== undefined && (form === null || formIsValid(form, token));
  const canPasskey = passkeysSupported();
  // A wallet that pays its own gas deploys in the validation prefix, with no room for a setup.
  const oneMethodOnly = !info.gasSponsored;
  const locked = (row: Row) => busy !== null || (oneMethodOnly && !ticks[row] && ticked.length > 0);

  const toggle = (row: Row) => (event: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setTicks({ ...ticks, [row]: event.target.checked });
  };

  const finish = async (world: PlanOwner | null, rootHint: Hex | null, held: Keys) => {
    const row = ownerRow as Row;
    if (!token) return;
    setBusy("Creating your wallet…");
    setError(null);
    try {
      const owner: PlanOwner = world ?? { kind: "passkey", ...facts(held[row as KeyRow] as EnrolledPasskey) };
      const indexOf = (id: string) => (id === row ? 0 : extraRows.indexOf(id as KeyRow) + 1);
      const plan: WalletPlan = {
        owner,
        extras: extraRows.map((extra) => facts(held[extra] as EnrolledPasskey)),
        wait: waitOn ? wait : 0,
        ...(form ? { sends: formSends(form, indexOf, token) } : {}),
      };
      const planned = await api.walletPlan(plan);
      if (planned.ownerSlot !== null) {
        const key = held[row as KeyRow] as EnrolledPasskey;
        savePasskey(planned.address, planned.ownerSlot, {
          credentialId: key.credentialId,
          name: ROW_NAME[row as KeyRow],
        });
      }
      extraRows.forEach((extra, index) => {
        savePasskey(planned.address, planned.extraSlots[index], {
          credentialId: (held[extra] as EnrolledPasskey).credentialId,
          name: ROW_NAME[extra],
        });
      });
      setWallet({ address: planned.address, plan, rootHint });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not create the wallet.");
      setBusy(null);
    }
  };

  /** Asks for each ticked key. A failure keeps the keys that exist, so a retry asks only for the rest. */
  const collectKeys = async (): Promise<Keys | null> => {
    const held = { ...keys };
    setError(null);
    for (const row of neededKeys) {
      setBusy(ROW_PROMPT[row]);
      try {
        // The WebAuthn user ID comes from this name. Two credentials with one user ID replace each other.
        const tag = crypto.randomUUID().slice(0, 8);
        held[row] = await enrolPasskey(`WAVE ${tag} ${ROW_NAME[row]}`, ROW_ATTACHMENT[row]);
        setKeys({ ...held });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The device did not create a passkey.");
        setBusy(null);
        return null;
      }
    }
    setBusy(null);
    return held;
  };

  const create = async () => {
    const held = await collectKeys();
    if (held && !ticks.world) await finish(null, null, held);
  };

  const onWorldProof = async (proof: WorldProof, raw: unknown) => {
    setError(null);
    const request: WorldVerifyRequest =
      info.world.mode === "idkit" ? { source: "idkit", result: raw } : { source: "dev", proof };
    try {
      const verified = await api.worldVerify(request);
      await finish({ kind: "world", nullifierHash: verified.ownerNullifierHash }, verified.merkleRoot, keys);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAVE could not create the wallet.");
    }
  };

  const ownerLine = (row: Row) =>
    ownerRow === row ? (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Owner method:</span> approves big sends and changes to
        this wallet.
      </p>
    ) : null;

  const worldDetail = info.world.mode === "dev" ? "Test identity. Not a real World ID." : "Approve in World App.";
  const noPasskeys = canPasskey ? null : "This browser has no passkey support.";
  const keyStepDone = ticked.length > 0 && neededKeys.length === 0;

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Choose how you approve</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          WAVE has no seed phrase. Tick the methods that you want. Every method is optional, and any mix
          works.
        </p>
      </div>

      <fieldset>
        <legend className="sr-only">Approval methods</legend>
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          <MethodRow
            icon={<Globe aria-hidden="true" className="size-5" />}
            title="World ID"
            detail={worldDetail}
            checked={ticks.world}
            disabled={locked("world")}
            owner={ownerRow === "world"}
            onChange={toggle("world")}
          >
            {ownerLine("world")}
          </MethodRow>
          <MethodRow
            icon={<Fingerprint aria-hidden="true" className="size-5" />}
            title="Passkey on this device (Face ID / Touch ID)"
            detail={noPasskeys ?? "Your device chooses the prompt."}
            checked={ticks.passkey}
            disabled={locked("passkey") || !canPasskey}
            owner={ownerRow === "passkey"}
            onChange={toggle("passkey")}
          >
            {ownerLine("passkey")}
          </MethodRow>
          <MethodRow
            icon={<KeyRound aria-hidden="true" className="size-5" />}
            title="Security key"
            detail={noPasskeys ?? "A key that you plug in or tap."}
            checked={ticks.key}
            disabled={locked("key") || !canPasskey}
            owner={ownerRow === "key"}
            onChange={toggle("key")}
          >
            {ownerLine("key")}
          </MethodRow>
          <MethodRow
            icon={<Nfc aria-hidden="true" className="size-5" />}
            title="NFC card"
            detail="Coming later."
            checked={false}
            disabled
          />
        </ul>
      </fieldset>

      {form && token ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">How do you want to approve sends?</h2>
          <LimitChoices
            methods={limitMethods}
            form={form}
            token={token}
            disabled={busy !== null}
            onChange={setForm}
          />
        </section>
      ) : null}

      <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={waitOn}
            disabled={busy !== null}
            onChange={(event) => setWaitOn(event.target.checked)}
            className="size-5 shrink-0 accent-current"
          />
          <span className="text-sm font-medium">Wait before risky changes</span>
        </label>
        <p className="text-sm text-muted-foreground">
          A risky change is a higher daily limit, a looser limit, a new or removed method, or a token
          permission. It does not run at once. The wait starts when you approve the change. When it
          ends, press Execute. Until then, you can cancel it. Sends under your limit do not wait.
        </p>
        {waitOn ? (
          <>
            <SelectField
              label="Wait for"
              name="wait"
              value={wait}
              disabled={busy !== null}
              onChange={(event) => setWait(Number(event.target.value))}
            >
              {WAITS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </SelectField>
            <p className="text-sm text-muted-foreground">If someone steals a method, this is your time to cancel.</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No wait. A stolen owner method can change rules and spend at once.</p>
        )}
      </div>

      {oneMethodOnly ? (
        <p className="text-sm text-muted-foreground">
          On this network a new wallet holds one method. You can add more in Settings.
        </p>
      ) : null}

      {ticked.length === 0 ? (
        <p className="text-sm text-muted-foreground">Tick at least one method.</p>
      ) : null}
      {ticked.length === 1 ? (
        <Notice tone="warning" title="If you lose this method, you lose this wallet. Add a second method." />
      ) : null}
      {ticked.length > 1 ? (
        <p className="text-sm text-muted-foreground">
          Recovery needs two device-bound methods other than the owner method.
        </p>
      ) : null}
      {ticked.length > 0 && !ticks.world ? (
        <Notice title="This wallet has no proof of human">
          With no World ID, the chain does not check that a human owns this wallet. You cannot add World ID
          later.
        </Notice>
      ) : null}

      {ticks.world && keyStepDone ? (
        <WorldScan
          world={info.world}
          signal={CREATE_SIGNAL}
          label={ticked.length > 1 ? "Scan with World ID to finish" : "Create wallet with World ID"}
          disabled={offline || !limitsValid || busy !== null}
          onProof={onWorldProof}
        />
      ) : (
        <Button
          onClick={() => void create()}
          disabled={ticked.length === 0 || offline || !limitsValid || busy !== null}
        >
          {busy ?? (error ? "Try again" : "Create wallet")}
        </Button>
      )}
      {error ? (
        <Notice tone="danger" title="WAVE could not create the wallet">
          {error}
        </Notice>
      ) : null}
    </Card>
  );
}
