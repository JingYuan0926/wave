import { Plus } from "lucide-react";
import { agentToCard, methodToCard } from "../lib/cards";
import { useNow, useStore } from "../store";
import { CardFace } from "../components/CardHolder";
import { PrimaryButton, Sheet, focusRing } from "../components/ui";
import { NotOnWhitechain } from "./OtherSheets";

/**
 * Adding an approval method needs the owner and a 48 hour delay. On Whitechain the wallet has one
 * method, its owner passkey; more methods come with the next contract version.
 */
export function CreateCardSheet({ onClose }: { kind?: "passkey" | "nfc"; onClose: () => void }) {
  return (
    <Sheet title="Add an approval method" onClose={onClose}>
      <NotOnWhitechain>
        On Whitechain your wallet has one method: the passkey that owns it. A second passkey and NFC cards run on the WAVE frame-transaction network, and they are not on Whitechain yet.
      </NotOnWhitechain>
      <div className="mt-5">
        <PrimaryButton onClick={onClose}>OK</PrimaryButton>
      </div>
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
