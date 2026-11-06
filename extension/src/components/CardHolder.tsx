import { useId, type ReactNode } from "react";
import { ChevronRight, Clock, Globe, KeyRound, Nfc, Plus, ScanFace, type LucideIcon } from "lucide-react";
import type { CardDesign, MethodKind } from "../data";
import { WaveMark, focusRing } from "./ui";

export const CARD_DESIGNS: Record<CardDesign, [string, string, string]> = {
  ocean: ["#0a4a57", "#1497a8", "#5fe0e8"],
  dusk: ["#3a2a7a", "#7b5bd6", "#c8b8ff"],
  coral: ["#8f2a2a", "#e8604a", "#ffc38a"],
  mint: ["#070808", "#2f5a4b", "#c2fae5"],
  night: ["#0b1b2b", "#24425e", "#6b93b5"],
};

export const METHOD_KIND_ICON: Record<MethodKind, LucideIcon> = {
  worldid: Globe,
  faceid: ScanFace,
  passkey: KeyRound,
  nfc: Nfc,
};

export function CardArt({ design }: { design: CardDesign }) {
  const id = useId();
  const [a, b, c] = CARD_DESIGNS[design];
  return (
    <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 size-full" aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="0.55" stopColor={b} />
          <stop offset="1" stopColor={c} />
        </linearGradient>
      </defs>
      <rect width="320" height="200" fill={`url(#${id}-g)`} />
      <path d="M0 46 C 50 26, 95 66, 150 44 S 250 22, 320 40 V200 H0Z" fill="#fff" opacity="0.1" />
      <path d="M0 62 C 60 44, 115 82, 180 58 S 280 46, 320 58 V200 H0Z" fill="#fff" opacity="0.12" />
      <path d="M0 80 C 70 66, 125 98, 200 78 S 290 70, 320 78 V200 H0Z" fill="#fff" opacity="0.14" />
      <path d="M0 120 C 80 104, 140 140, 220 118 S 300 110, 320 118 V200 H0Z" fill="#000" opacity="0.08" />
    </svg>
  );
}

/** What a card shows. Method cards and agent budget cards both use this. */
export type HolderCard = {
  id: string;
  design: CardDesign;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  /** e.g. "Active in 47h". Greys the card out. */
  pendingLabel?: string;
};

/** A full card face. In the holder only its top edge shows. */
export function CardFace({ card, label }: { card: HolderCard; label?: string }) {
  const Icon = card.icon;
  return (
    <div className="relative h-[200px] w-full overflow-hidden rounded-[16px] shadow-[0_-2px_10px_rgba(7,8,8,0.12)]">
      <div className={card.pendingLabel ? "absolute inset-0 grayscale-[0.7]" : "absolute inset-0"}>
        <CardArt design={card.design} />
      </div>
      <div className="relative flex items-start justify-between px-4 pt-3.5 text-white">
        {label ? (
          <span className="flex min-w-0 items-center gap-1 text-[17px] font-semibold drop-shadow-sm">
            <span className="truncate">{label}</span>
            <ChevronRight className="size-4 shrink-0" aria-hidden />
          </span>
        ) : (
          <span />
        )}
        <WaveMark className="size-7 shrink-0" />
      </div>
      <div className="absolute inset-x-4 bottom-4 flex items-end justify-between gap-3 text-white">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/20 backdrop-blur-sm" aria-hidden>
            <Icon className="size-[18px]" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-bold drop-shadow-sm">{card.title}</span>
            <span className="block truncate text-xs opacity-90">{card.subtitle}</span>
          </span>
        </span>
        {card.pendingLabel && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2 py-1 text-[11px] font-bold text-warn">
            <Clock className="size-3" aria-hidden />
            {card.pendingLabel}
          </span>
        )}
      </div>
    </div>
  );
}

const PEEK = 14; // how much of each card behind the front one shows
const VISIBLE = 66; // how much of the front card shows above the pocket
const NOTCH_DEPTH = 18;
const MAX_STACK = 4;

/** The grey pocket edge with a thumb-notch cutout in the middle. */
function Pocket() {
  // One element with an elliptical mask, so there are no seams when the
  // phone preview is scaled.
  const mask = `radial-gradient(ellipse 44px ${NOTCH_DEPTH}px at 50% 0, transparent 97%, #000 100%)`;
  return (
    <div
      className="absolute -inset-x-1 -bottom-px z-10 bg-surface"
      style={{ height: NOTCH_DEPTH + 1, maskImage: mask, WebkitMaskImage: mask }}
      aria-hidden
    />
  );
}

export function cardCountLabel(n: number, noun: string) {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

/**
 * A card holder: cards tucked into a pocket at the top, newest in front,
 * with the holder's own content below.
 */
export function CardHolder({
  ariaLabel,
  cards,
  frontLabel,
  emptyLabel,
  newCardId,
  onOpenCards,
  onCreate,
  children,
}: {
  ariaLabel: string;
  cards: HolderCard[];
  frontLabel: string;
  emptyLabel: string;
  newCardId: string | null;
  onOpenCards: () => void;
  onCreate: () => void;
  children: ReactNode;
}) {
  const stack = cards.slice(-MAX_STACK); // newest last = front of the holder
  const slotHeight = (Math.max(stack.length, 1) - 1) * PEEK + VISIBLE + NOTCH_DEPTH;

  return (
    <article className="flex h-full flex-col rounded-[28px] bg-surface p-2.5" aria-label={ariaLabel}>
      <div className="relative overflow-hidden rounded-t-[18px]" style={{ height: slotHeight }}>
        {stack.length === 0 ? (
          <button
            type="button"
            onClick={onCreate}
            className={`absolute inset-x-0 top-0 flex h-[200px] items-start justify-center rounded-[16px] border-2 border-dashed border-ink/15 pt-5 text-[15px] font-semibold text-ink-2 hover:bg-white/60 ${focusRing}`}
          >
            <span className="flex items-center gap-1.5">
              <Plus className="size-4" aria-hidden /> {emptyLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenCards}
            aria-label={`${frontLabel}: ${cards.map((c) => c.title).join(", ")}`}
            className={`absolute inset-0 block text-left ${focusRing}`}
          >
            {stack.map((card, i) => (
              <div
                key={card.id}
                className={`absolute inset-x-0 ${card.id === newCardId ? "animate-card-in" : ""}`}
                style={{ top: i * PEEK, zIndex: i }}
              >
                <CardFace card={card} label={i === stack.length - 1 ? frontLabel : undefined} />
              </div>
            ))}
          </button>
        )}
        <Pocket />
      </div>

      <div className="flex flex-1 flex-col px-2.5 pb-1.5 pt-3">{children}</div>
    </article>
  );
}

/** A row inside a holder body: icon, text, chevron. */
export function HolderRow({ lead, children, onClick }: { lead: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 rounded-lg py-2 text-left ${focusRing}`}>
      {lead}
      <span className="min-w-0 flex-1 text-[17px] text-ink-2 tabular-nums">{children}</span>
      <ChevronRight className="size-5 shrink-0 text-ink-2" aria-hidden />
    </button>
  );
}

export function HolderTitle({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center justify-between rounded-lg py-1 text-left ${focusRing}`}>
      <span className="text-2xl font-bold tracking-tight">{children}</span>
      <ChevronRight className="size-5 text-ink-2" aria-hidden />
    </button>
  );
}

export function HolderChip({ icon: Icon, children, onClick }: { icon: LucideIcon; children: ReactNode; onClick: () => void }) {
  return (
    <div className="mt-auto pt-6">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex h-10 items-center gap-2 rounded-full bg-surface-2 px-3.5 text-[15px] font-semibold text-ink-2 hover:bg-[#dadddd] ${focusRing}`}
      >
        <Icon className="size-4" aria-hidden /> {children}
      </button>
    </div>
  );
}
