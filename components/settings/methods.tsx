"use client";

import { Fingerprint, Globe, Nfc } from "lucide-react";
import { useState } from "react";
import { ApproveFlow, requireMethod, type ApprovalRequest } from "@/components/approve-flow";
import { Badge, Button, Card, Notice, SectionTitle, Sheet } from "@/components/ui";
import { useWallet } from "@/components/wallet-provider";
import type { MethodView, TierView, TokenInfo, TokenRules } from "@/lib/api-types";
import { formatAmount } from "@/lib/ui/format";
import { findPasskey, savePasskey } from "@/lib/ui/local";
import { enrolPasskey, passkeysSupported } from "@/lib/ui/passkey";
import { WORLD_ID, freePasskeySlot, maskHas, methodLabel } from "@/lib/ui/rules";

const UINT96_MAX = (BigInt(1) << BigInt(96)) - BigInt(1);

function periodLabel(seconds: number): string {
  if (seconds === 86400) return "day";
  if (seconds === 604800) return "week";
  return `${seconds} seconds`;
}

function tierLine(tier: TierView, token: TokenInfo): string {
  const amount = (value: string) => `${formatAmount(value, token.decimals)} ${token.symbol}`;
  const size = BigInt(tier.upTo) >= UINT96_MAX ? `Any amount of ${token.symbol}` : `Up to ${amount(tier.upTo)}`;
  const cap = tier.cap !== "0" ? `, ${amount(tier.cap)} per ${periodLabel(tier.period)}` : "";
  return `${size}${cap}, ${tier.delay === 0 ? "at once" : "after a delay"}`;
}

/** The transfers this method can approve, from the rules on the chain. */
function spendLines(
  view: MethodView,
  rules: TokenRules[],
  tokenBy: (address: string) => TokenInfo | undefined,
): string[] {
  const isWorld = view.ref.kind === "world";
  const synced = view.backup === "synced";
  return rules.flatMap((rule) => {
    const token = tokenBy(rule.token);
    if (!token) return [];
    // No tiers is the code default: World ID only, no delay.
    if (rule.tiers.length === 0) return isWorld ? [`Any amount of ${token.symbol}, at once`] : [];
    return rule.tiers
      .filter((tier) => maskHas(tier.methods, view) && (!synced || tier.small))
      .map((tier) => tierLine(tier, token));
  });
}

function otherLines(view: MethodView): string[] {
  if (view.ref.kind === "world") {
    return [
      "Add or remove a method (waits in the queue)",
      "Loosen spending rules (waits in the queue)",
      "Token approvals and contract calls (wait in the queue)",
      "Cancel any queued action",
    ];
  }
  return [
    "Make spending rules stricter, at once",
    "Cancel a normal queued action",
    ...(view.backup === "device-bound" ? ["Start or approve a recovery"] : []),
  ];
}

function MethodRow({
  view,
  onRemove,
}: {
  view: MethodView;
  onRemove: (view: MethodView) => void;
}) {
  const { wallet, local, info, account, tokenBy } = useWallet();
  const spends = spendLines(view, account?.rules ?? [], tokenBy);
  const isPasskey = view.ref.kind === "passkey";
  const Icon = isPasskey ? Fingerprint : Globe;
  const here =
    view.ref.kind === "passkey" &&
    wallet !== null &&
    local !== null &&
    findPasskey(local, wallet.address, view.ref.slot) !== null;

  return (
    <li className="flex items-start gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{methodLabel(view.ref, info?.world)}</p>
        <p className="text-sm text-muted-foreground">
          {view.backup === "synced"
            ? "Synced passkey. It approves small tiers only."
            : view.backup === "device-bound"
              ? "Device-bound passkey."
              : info?.world.mode === "dev"
                ? "Not a real World ID. Always on."
                : "Always on. World App approves."}
          {isPasskey && !here ? " Not on this browser." : ""}
        </p>
        <p className="mt-2 text-xs font-medium">
          {isPasskey ? "Sends with no World ID scan" : "Sends it can approve, one scan each"}
        </p>
        {spends.length > 0 ? (
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {spends.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            None yet. Add this method to a{view.backup === "synced" ? " small" : ""} tier in
            Spending rules.
          </p>
        )}
        <p className="mt-1 text-xs font-medium">It can also</p>
        <ul className="list-disc pl-4 text-xs text-muted-foreground">
          {otherLines(view).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {isPasskey ? (
          <p className="mt-1 text-xs text-muted-foreground">
            It cannot add or remove methods, loosen rules, or approve token permissions. Those
            need World ID.
          </p>
        ) : null}
      </div>
      {isPasskey ? (
        <Button variant="ghost" onClick={() => onRemove(view)}>
          Remove
        </Button>
      ) : (
        <Badge>Always</Badge>
      )}
    </li>
  );
}

export function Methods() {
  const { wallet, account, info, offline } = useWallet();
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!wallet || !account) return null;

  const slot = freePasskeySlot(account.methods, account.pending);

  const open = (next: ApprovalRequest) => {
    setSheetKey((key) => key + 1);
    setRequest(next);
  };

  const addPasskey = async () => {
    if (!slot) return;
    setEnrolling(true);
    setError(null);
    try {
      // The WebAuthn user ID comes from this name. Two passkeys with one user ID on one
      // device replace each other, so the name holds the slot.
      const passkey = await enrolPasskey(`WAVE ${wallet.address.slice(0, 8)} passkey ${slot}`);
      savePasskey(wallet.address, slot, { credentialId: passkey.credentialId });
      open({
        action: {
          kind: "install-passkey",
          slot,
          publicKey: passkey.publicKey,
          backupEligible: passkey.backupEligible,
        },
        choices: requireMethod(account.methods, WORLD_ID, info?.world),
        method: WORLD_ID,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The device did not create a passkey.");
    } finally {
      setEnrolling(false);
    }
  };

  const remove = (view: MethodView) => {
    if (view.ref.kind !== "passkey") return;
    open({
      action: { kind: "remove-passkey", slot: view.ref.slot },
      choices: requireMethod(account.methods, WORLD_ID, info?.world),
      method: WORLD_ID,
    });
  };

  return (
    <Card>
      <SectionTitle hint="Adding or removing a method needs World ID, and waits in the queue.">
        Methods
      </SectionTitle>
      <ul className="flex flex-col gap-3">
        {account.methods.map((view) => (
          <MethodRow key={view.validator} view={view} onRemove={remove} />
        ))}
        <li className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
            <Nfc aria-hidden="true" className="size-4 text-muted-foreground" />
          </span>
          <p className="flex-1 text-sm text-muted-foreground">NFC card: coming later</p>
          <Button variant="ghost" disabled>
            Add
          </Button>
        </li>
      </ul>

      <div className="mt-4 flex flex-col gap-2">
        <Button
          variant="secondary"
          onClick={addPasskey}
          disabled={!slot || enrolling || offline || !passkeysSupported()}
        >
          <Fingerprint aria-hidden="true" className="size-4" />
          {enrolling ? "Waiting for your device…" : "Add passkey (Face ID / Touch ID / security key)"}
        </Button>
        {!slot ? (
          <p className="text-sm text-muted-foreground">
            All three passkey slots are in use or queued.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Face ID and Touch ID often report a synced passkey. A synced passkey approves small
          tiers only. A security key can be device-bound. Choose it in the browser prompt.
        </p>
        {error ? <Notice tone="danger" title="WAVE could not add the passkey">{error}</Notice> : null}
      </div>

      {request ? (
        <Sheet title="Change methods" onClose={() => setRequest(null)}>
          <ApproveFlow key={sheetKey} request={request} />
        </Sheet>
      ) : null}
    </Card>
  );
}
