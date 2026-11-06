import { useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { METHOD_INFO, type CardDesign } from "../data";
import { requestApproval } from "../lib/approvals";
import { agentToCard, methodToCard } from "../lib/cards";
import { useNow, useStore } from "../store";
import { CARD_DESIGNS, CardArt, CardFace, METHOD_KIND_ICON } from "../components/CardHolder";
import { METHOD_ICON, PrimaryButton, Sheet, focusRing } from "../components/ui";
import { ApprovingView, DoneView } from "../components/Approving";

const DESIGN_NAMES: Record<CardDesign, string> = {
  ocean: "Ocean",
  dusk: "Dusk",
  coral: "Coral",
  mint: "Mint",
  night: "Night",
};

type NewKind = "passkey" | "nfc";
const ADDABLE: NewKind[] = ["passkey", "nfc"];
const ADD_DELAY_MS = 48 * 3_600_000;

/**
 * Adds an approval method as a new card in the wallet's holder.
 * Needs World ID and waits 48 hours, so the card arrives greyed out
 * with "Active in 48h".
 */
export function CreateCardSheet({ kind: initialKind, onClose }: { kind?: NewKind; onClose: () => void }) {
  const { state, addMethodCard, addPending, flagNewCard } = useStore();
  const taken = new Set(state.cards.map((c) => c.kind));
  const available = ADDABLE.filter((k) => !taken.has(k));

  const [kind, setKind] = useState<NewKind | undefined>(
    initialKind && available.includes(initialKind) ? initialKind : available[0],
  );
  const [design, setDesign] = useState<CardDesign>("coral");
  const [step, setStep] = useState<"form" | "approving" | "done">("form");
  const createdId = useRef<string | null>(null);

  // Drop the new card into the holder once this sheet is out of the way.
  const close = () => {
    if (createdId.current) flagNewCard(createdId.current);
    onClose();
  };

  if (!kind) {
    return (
      <Sheet title="All methods added" onClose={onClose}>
        <p className="text-[15px] leading-relaxed text-ink-2">
          Your holder has every approval method WAVE supports right now.
        </p>
        <div className="mt-5">
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        </div>
      </Sheet>
    );
  }

  const approve = async () => {
    setStep("approving");
    await requestApproval("worldid");
    const activeAt = Date.now() + ADD_DELAY_MS;
    const id = addMethodCard({ kind, design, activeAt });
    createdId.current = id;
    addPending({
      title: `Add ${METHOD_INFO[kind].name}`,
      detail: "New approval method",
      proposedBy: "worldid",
      endsAt: activeAt,
      cancelBy: ["worldid", "faceid"],
      cardId: id,
    });
    setStep("done");
  };

  const preview = methodToCard({ id: "preview", kind, design, activeAt: 0 }, 0);
  const WorldIcon = METHOD_ICON.worldid;

  return (
    <Sheet title={step === "done" ? "" : "Add an approval method"} onClose={close}>
      {step === "form" && (
        <>
          <div className="mx-auto w-[88%]">
            <CardFace card={preview} label="New card" />
          </div>

          <div className="mt-6 space-y-5">
            <fieldset>
              <legend className="text-[15px] font-medium text-ink-2">Method</legend>
              <div className="mt-2 grid gap-2">
                {available.map((k) => {
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
                        <span className="block font-semibold">{METHOD_INFO[k].name}</span>
                        <span className="block text-sm text-muted">
                          {k === "nfc" ? "Tap a signing card to approve" : "Face ID or Touch ID on another device"}
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

            <p className="rounded-[20px] bg-warn-soft p-4 text-sm leading-snug text-ink-2">
              Adding a method needs <span className="font-semibold text-ink">World ID</span> and waits{" "}
              <span className="font-semibold text-ink">48 hours</span>. Your other methods can cancel it in that time.
            </p>

            <PrimaryButton onClick={approve}>
              <WorldIcon className="size-5" aria-hidden /> Approve with World ID
            </PrimaryButton>
          </div>
        </>
      )}

      {step === "approving" && <ApprovingView method="worldid" />}

      {step === "done" && (
        <DoneView
          title="Card added"
          body={`${METHOD_INFO[kind].name} is in your holder. It can approve in 48 hours.`}
          onDone={close}
        />
      )}
    </Sheet>
  );
}

/** Opens a holder: every card in it, plus a button to add one. */
export function CardsSheet({
  holder,
  onClose,
  onAdd,
}: {
  holder: "methods" | "agents";
  onClose: () => void;
  onAdd: () => void;
}) {
  const { state } = useStore();
  const now = useNow(60_000);
  const cards =
    holder === "methods"
      ? state.cards.map((c) => methodToCard(c, now)).reverse()
      : state.agents.map(agentToCard).reverse();

  return (
    <Sheet title={holder === "methods" ? "Approval methods" : "Agent budgets"} onClose={onClose}>
      <ul className="space-y-3">
        {cards.map((c) => (
          <li key={c.id}>
            <CardFace card={c} />
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
