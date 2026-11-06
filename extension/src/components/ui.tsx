import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Fingerprint, Globe, Nfc, ScanFace, X, type LucideIcon } from "lucide-react";
import type { MethodId } from "../data";
import { initials } from "../lib/format";

export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-wave-deep focus-visible:ring-offset-2 focus-visible:ring-offset-white";

export const METHOD_ICON: Record<MethodId, LucideIcon> = {
  worldid: Globe,
  faceid: ScanFace,
  nfc: Nfc,
};

export { Fingerprint };

/* ---------- Buttons ---------- */

type PillProps = {
  children: ReactNode;
  onClick?: () => void;
  tone?: "accent" | "white";
  icon?: LucideIcon;
  trailingIcon?: LucideIcon;
};

export function Pill({ children, onClick, tone = "white", icon: Icon, trailingIcon: Trailing }: PillProps) {
  const toneCls =
    tone === "accent"
      ? "bg-wave text-ink shadow-[0_6px_20px_-6px_rgba(95,224,232,0.9)] hover:brightness-95"
      : "bg-white text-ink border border-line shadow-[0_6px_20px_-8px_rgba(11,27,43,0.18)] hover:bg-surface";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-11 items-center gap-2 rounded-full px-5 text-base font-semibold transition-[filter,background-color,transform] active:scale-[0.97] ${toneCls} ${focusRing}`}
    >
      {Icon && <Icon className="size-[18px]" aria-hidden />}
      {children}
      {Trailing && <Trailing className="size-5" aria-hidden />}
    </button>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  tone = "deep",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  tone?: "deep" | "accent" | "ghost";
}) {
  const toneCls = {
    deep: "bg-wave-deep text-white hover:bg-[#083b45]", // darker shade of wave-deep for hover
    accent: "bg-wave text-ink hover:brightness-95",
    ghost: "bg-surface text-ink hover:bg-surface-2",
  }[tone];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-13 w-full items-center justify-center gap-2 rounded-full px-6 text-base font-semibold transition-[filter,background-color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${toneCls} ${focusRing}`}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`grid size-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface ${focusRing}`}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

/* ---------- Layout ---------- */

export function TopBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 flex min-h-[84px] items-center justify-between gap-3 bg-linear-to-b from-white from-55% to-white/0 px-5 pb-4 pt-5">
      <div className="min-w-11">{left}</div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className={`grid size-11 place-items-center rounded-full border border-line bg-white shadow-[0_6px_20px_-8px_rgba(11,27,43,0.18)] hover:bg-surface ${focusRing}`}
    >
      <ChevronLeft className="size-5" aria-hidden />
    </button>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="px-5 pb-4">
      <h1 className="text-[2rem] font-bold leading-tight tracking-tight">{children}</h1>
      {sub && <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{sub}</p>}
    </div>
  );
}

export function SectionHeader({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-5 pb-2">
      <h2 className="text-2xl font-bold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h2 className="mx-5 border-b border-line pb-3 text-[15px] font-medium text-ink-2">{children}</h2>;
}

export function IconCircle({ icon: Icon, tone = "outline" }: { icon: LucideIcon; tone?: "outline" | "soft" | "deep" }) {
  const cls = {
    outline: "border border-line bg-white text-ink",
    soft: "bg-wave-soft text-wave-deep",
    deep: "bg-wave-deep text-white",
  }[tone];
  return (
    <span className={`grid size-12 shrink-0 place-items-center rounded-full ${cls}`} aria-hidden>
      <Icon className="size-[22px]" strokeWidth={1.9} />
    </span>
  );
}

export function ListRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-4 rounded-2xl px-5 py-3 text-left transition-colors hover:bg-surface ${focusRing}`}
    >
      <IconCircle icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold">{label}</span>
        {hint && <span className="block truncate text-sm text-muted">{hint}</span>}
      </span>
      <ChevronRight className="size-5 shrink-0 text-ink" aria-hidden />
    </button>
  );
}

export function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const palette = ["bg-wave-soft text-wave-deep", "bg-[#ece8ff] text-[#3d2a8a]", "bg-[#ffeadd] text-[#8a3a0a]", "bg-[#e3f4e8] text-[#155c33]"];
  const idx = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % palette.length;
  const sz = size === "lg" ? "size-14 text-lg" : "size-12 text-base";
  return (
    <span className={`grid shrink-0 place-items-center rounded-full font-bold ${sz} ${palette[idx]}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function MethodChip({ method, label }: { method: MethodId; label?: string }) {
  const Icon = METHOD_ICON[method];
  const names: Record<MethodId, string> = { worldid: "World ID", faceid: "Face ID", nfc: "NFC card" };
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white px-2.5 text-[13px] font-semibold text-ink-2 ring-1 ring-line">
      <Icon className="size-3.5" aria-hidden />
      {label ?? names[method]}
    </span>
  );
}

/* ---------- Sheet ---------- */

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // preventScroll: a plain focus() makes Chrome scroll the phone's
    // overflow-hidden containers, which shifts the whole screen.
    const auto = panelRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    (auto ?? panelRef.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 animate-fade-in bg-ink/45" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[92%] animate-sheet-in overflow-y-auto rounded-t-[28px] bg-white px-5 pb-[calc(2rem+var(--nav-bottom,0px))] pt-2.5 shadow-2xl outline-none no-scrollbar"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line" aria-hidden />
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-[22px] font-bold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`grid size-10 place-items-center rounded-full bg-surface hover:bg-surface-2 ${focusRing}`}
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Brand art ---------- */

export function WaveBand({ variant = "ocean" }: { variant?: "ocean" | "dusk" }) {
  const id = useId();
  const stops =
    variant === "ocean"
      ? ["#0a4a57", "#1497a8", "#5fe0e8"]
      : ["#3a2a7a", "#7b5bd6", "#c8b8ff"];
  return (
    <svg viewBox="0 0 320 88" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={stops[0]} />
          <stop offset="0.55" stopColor={stops[1]} />
          <stop offset="1" stopColor={stops[2]} />
        </linearGradient>
      </defs>
      <rect width="320" height="88" fill={`url(#${id}-g)`} />
      <path d="M0 40 C 50 22, 95 58, 150 38 S 250 18, 320 34 V88 H0Z" fill="#fff" opacity="0.12" />
      <path d="M0 54 C 60 38, 115 74, 180 52 S 280 40, 320 52 V88 H0Z" fill="#fff" opacity="0.16" />
      <path d="M0 66 C 70 54, 125 84, 200 66 S 290 58, 320 66 V88 H0Z" fill="#fff" opacity="0.2" />
      <path d="M0 78 C 80 70, 130 92, 210 78 S 300 72, 320 78 V88 H0Z" fill="#f2f5f7" />
    </svg>
  );
}

export function WaveMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="M3 13c3.2-3.5 6.4-3.5 9.6 0s6.4 3.5 9.6 0 4.8-3.5 6.8-1.5" />
      <path d="M3 21c3.2-3.5 6.4-3.5 9.6 0s6.4 3.5 9.6 0 4.8-3.5 6.8-1.5" opacity="0.6" />
    </svg>
  );
}

export function TokenIcon({ token }: { token: "USDC" | "ETH" }) {
  // Neutral token glyphs; not the official logos.
  return token === "USDC" ? (
    <span className="grid size-8 place-items-center rounded-full bg-[#2775ca] text-sm font-bold text-white" aria-hidden>
      $
    </span>
  ) : (
    <span className="grid size-8 place-items-center rounded-full bg-[#5b6fd8] text-sm font-bold text-white" aria-hidden>
      Ξ
    </span>
  );
}
