import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { METHOD_INFO, NFC_NOTE, type CardDesign } from "../data";
import { agentToCard, methodToCard } from "../lib/cards";
import {
  CONFIG_DELAY,
  changeTiming,
  enrolPasskey,
  freePasskeySlot,
  ownerName,
  passkeyCardId,
  passkeyErrorText,
  passkeysSupported,
  requireMethod,
  savePasskey,
  type MethodRef,
} from "../lib/wave";
import { useLateApproval, useNow, useStore } from "../store";
import { CARD_DESIGNS, CardArt, CardFace, METHOD_KIND_ICON } from "../components/CardHolder";
import { PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ApproveButtons, ApprovingView, NotConnectedView } from "../components/Approving";

const DESIGN_NAMES: Record<CardDesign, string> = {
  navy: "Ocean",
  slate: "Slate",
  midnight: "Midnight",
};

// SAMPLE: no WAVE function yet. WAVE has no NFC card, so only the passkey row is real.
type NewKind = "passkey" | "nfc";

/**
 * Adds an approval method as a new card in the wallet's holder. The same steps as
 * components/settings/methods.tsx: the device makes the key, then the owner method approves it.
 * A queued card reads "Active in", and the wait comes from this wallet.
 */
export function CreateCardSheet({ kind: initialKind, onClose }: { kind?: NewKind; onClose: () => void }) {
  const { state, flagNewCard } = useStore();
  const { account, info, local, localWallet: wallet, offline } = state;
  const [kind, setKind] = useState<NewKind>(initialKind ?? "passkey");
  // SAMPLE: no WAVE function yet. WAVE stores no card design, so this changes only the preview.
  const [design, setDesign] = useState<CardDesign>("navy");
  // SAMPLE: no WAVE function yet. The NFC path ends at this step and sends nothing.
  const [step, setStep] = useState<"form" | "not-connected">("form");
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval, request, begin } = useLateApproval();
  const { stage } = approval;

  const title = "Add an approval method";
  if (!account || !wallet) {
    return (
      <Sheet title={title} onClose={onClose}>
        <p className="text-[15px] leading-relaxed text-ink-2">Your wallet has not loaded yet. Try again in a moment.</p>
      </Sheet>
    );
  }

  const slot = freePasskeySlot(account.methods, account.pending);
  if (!slot && kind === "passkey" && !request) {
    return (
      <Sheet title="All methods added" onClose={onClose}>
        <p className="text-[15px] leading-relaxed text-ink-2">All three passkey slots are in use or queued.</p>
        <div className="mt-5">
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        </div>
      </Sheet>
    );
  }

  const choices = requireMethod(account.methods, account.owner, info?.world);
  const preview = methodToCard(
    kind === "passkey"
      ? { id: "preview", kind, design, activeAt: 0, title: `Passkey ${slot}`, subtitle: "Not active yet" }
      : { id: "preview", kind, design, activeAt: 0 },
    0,
  );
  const blocked = offline
    ? "The chain does not answer. Nothing can be added now."
    : !passkeysSupported()
      ? "This browser cannot make a passkey."
      : null;

  const add = async (method: MethodRef) => {
    if (!slot) return;
    setEnrolling(true);
    setError(null);
    try {
      // The WebAuthn user ID comes from this name. Two passkeys with one user ID on one device
      // replace each other, so the name holds the slot.
      const passkey = await enrolPasskey(`WAVE ${wallet.address.slice(0, 8)} passkey ${slot}`);
      savePasskey(wallet.address, slot, { credentialId: passkey.credentialId });
      begin({
        action: { kind: "install-passkey", slot, publicKey: passkey.publicKey, backupEligible: passkey.backupEligible },
        method,
        onAccepted: () => flagNewCard(passkeyCardId(slot)),
      });
    } catch (cause) {
      setError(`${passkeyErrorText(cause, "The device did not create a passkey.")} Nothing reached the chain.`);
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <Sheet title={stage.name === "done" ? "" : title} onClose={onClose}>
      {request && stage.name !== "idle" && <ApprovingView approval={approval} onDone={onClose} />}

      {request && stage.name === "idle" && (
        <div className="space-y-2">
          <ApproveButtons choices={choices} onPick={(method) => void approval.approveNow(method)} />
        </div>
      )}

      {!request && step === "form" && (
        <>
          <div className="mx-auto w-[88%]">
            <CardFace card={preview} label="New card" />
          </div>

          <div className="mt-6 space-y-5">
            <fieldset>
              <legend className="text-[15px] font-medium text-ink-2">Method</legend>
              <div className="mt-2 grid gap-2">
                {(["passkey", "nfc"] as const).map((k) => {
                  const Icon = METHOD_KIND_ICON[k];
                  const selected = kind === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setKind(k)}
                      className={`flex items-center gap-3 rounded-2xl p-3 text-left ring-2 transition-colors ${
                        selected ? "bg-wave-mist ring-wave-deep" : "bg-surface ring-transparent hover:bg-surface-2"
                      } ${focusRing}`}
                    >
                      <span className="grid size-10 place-items-center rounded-full bg-white ring-1 ring-line" aria-hidden>
                        <Icon className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{k === "nfc" ? METHOD_INFO.nfc.name : "New passkey"}</span>
                        <span className="block text-sm text-muted">
                          {k === "nfc" ? NFC_NOTE : "Face ID, Touch ID or a security key"}
                        </span>
                      </span>
                      {selected && <Check className="size-5 text-wave-deep" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-[15px] font-medium text-ink-2">Card design</legend>
              <div className="mt-2 flex gap-3">
                {(Object.keys(CARD_DESIGNS) as CardDesign[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={design === d}
                    aria-label={DESIGN_NAMES[d]}
                    onClick={() => setDesign(d)}
                    className={`relative size-12 overflow-hidden rounded-full ring-offset-2 transition ${design === d ? "ring-2 ring-ink" : ""} ${focusRing}`}
                  >
                    <CardArt design={d} />
                    {design === d && <Check className="relative mx-auto size-5 text-white drop-shadow" aria-hidden />}
                  </button>
                ))}
              </div>
            </fieldset>

            {kind === "nfc" ? (
              <PrimaryButton onClick={() => setStep("not-connected")}>Add NFC card</PrimaryButton>
            ) : (
              <>
                <div className="space-y-2 rounded-[20px] bg-warn-soft p-4 text-sm leading-snug text-ink-2">
                  <p>
                    Adding a method needs <span className="font-semibold text-ink">{ownerName(account, { wallet, local, info })}</span>.{" "}
                    {changeTiming(account.waitSeconds, CONFIG_DELAY)}
                  </p>
                  <p>Face ID and Touch ID often make a synced passkey. A synced passkey needs a limit and cannot run a recovery.</p>
                </div>

                {blocked && (
                  <p role="alert" className="text-sm font-semibold leading-snug text-danger">
                    {blocked}
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm font-semibold leading-snug text-danger">
                    {error}
                  </p>
                )}
                {enrolling ? (
                  <PrimaryButton disabled>Waiting for your device…</PrimaryButton>
                ) : (
                  !blocked && <ApproveButtons choices={choices} onPick={(method) => void add(method)} />
                )}
              </>
            )}
          </div>
        </>
      )}

      {!request && step === "not-connected" && <NotConnectedView what="An NFC card" onDone={onClose} />}
    </Sheet>
  );
}

/** Opens a holder: every card in it, plus a button to add one. */
export function CardsSheet({
  holder,
  onClose,
  onAdd,
  onPick,
}: {
  holder: "methods" | "agents";
  onClose: () => void;
  onAdd: () => void;
  /** Makes each card a button. */
  onPick?: (id: string) => void;
}) {
  const { state } = useStore();
  const now = useNow(60_000);
  const cards =
    holder === "methods"
      ? state.cards.map((c) => methodToCard(c, now)).reverse()
      : state.agents.map(agentToCard).reverse();

  return (
    <Sheet title={holder === "methods" ? "Approval methods" : "Agent wallets"} onClose={onClose}>
      <ul className="space-y-3">
        {cards.map((c) => (
          <li key={c.id}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(c.id)}
                aria-label={`Open ${c.title}`}
                className={`block w-full rounded-[16px] text-left ${focusRing}`}
              >
                <CardFace card={c} />
              </button>
            ) : (
              <CardFace card={c} />
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onAdd}
        className={`mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-[20px] border border-dashed border-ink/20 text-[15px] font-semibold text-ink-2 hover:bg-surface ${focusRing}`}
      >
        <Plus className="size-5" aria-hidden /> {holder === "methods" ? "Add an approval method" : "Give an agent a budget"}
      </button>
    </Sheet>
  );
}
