import { ArrowRightLeft, Bot, House, Users, type LucideIcon } from "lucide-react";
import { focusRing } from "./ui";

export type Tab = "home" | "agents" | "recipients" | "payments";

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: House },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "recipients", label: "Recipients", icon: Users },
  { id: "payments", label: "Payments", icon: ArrowRightLeft },
];

export function BottomNav({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-32 bg-linear-to-t from-page via-page/85 to-page/0" aria-hidden />
      <nav aria-label="Main" className="absolute inset-x-3 bottom-[var(--nav-bottom,0.75rem)] z-30">
        <div className="flex gap-1 rounded-full border border-line/80 bg-white/95 p-1.5 shadow-[0_10px_34px_-10px_rgba(0,0,0,0.28)] backdrop-blur-md">
          {TABS.map(({ id, label, icon: Icon }) => {
            const isActive = id === active;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onChange(id)}
                aria-current={isActive ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-1 rounded-full py-2.5 text-xs font-semibold transition-colors ${
                  isActive ? "bg-wave-soft text-wave-press" : "text-ink-2 hover:bg-surface hover:text-ink"
                } ${focusRing}`}
              >
                <Icon className="size-[22px]" strokeWidth={isActive ? 2.2 : 1.8} aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
