import { RefreshCw, TriangleAlert, X } from "lucide-react";
import { useStore } from "../store";
import { focusRing } from "./ui";

/** The real state of the server and the chain. It also shows a notice from the store. */
export function StatusBanner() {
  const { state, refresh, dismissNotice } = useStore();
  const text = state.offline
    ? "The chain does not answer. Balances can be old, and nothing can be sent."
    : state.error
      ? `WAVE could not read your wallet: ${state.error}`
      : null;

  return (
    <>
      {text && (
        <div className="mx-5 mt-3 flex items-start gap-3 rounded-[20px] bg-danger-soft p-3.5" role="alert">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <p className="min-w-0 flex-1 text-sm leading-snug text-ink">{text}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Try again"
            className={`grid size-8 shrink-0 place-items-center rounded-full bg-white/70 hover:bg-white ${focusRing}`}
          >
            <RefreshCw className="size-4" aria-hidden />
          </button>
        </div>
      )}
      {state.notice && (
        <div className="mx-5 mt-3 flex items-start gap-3 rounded-[20px] bg-warn-soft p-3.5" role="status">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0 flex-1 text-sm leading-snug text-ink">{state.notice}</p>
          <button
            type="button"
            onClick={dismissNotice}
            aria-label="Dismiss"
            className={`grid size-8 shrink-0 place-items-center rounded-full bg-white/70 hover:bg-white ${focusRing}`}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}
