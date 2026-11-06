import { CircleCheck, ExternalLink } from "lucide-react";
import type { MethodId } from "../data";
import { METHOD_LABEL } from "../data";
import { WORLD_ID_SIMULATOR_URL } from "../lib/approvals";
import { METHOD_ICON, PrimaryButton, focusRing } from "./ui";

export function ApprovingView({ method }: { method: MethodId }) {
  const Icon = METHOD_ICON[method];
  return (
    <div className="flex flex-col items-center py-6 text-center" role="status" aria-live="polite">
      <div className="relative grid size-28 place-items-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-wave/40 motion-reduce:hidden" aria-hidden />
        <span className="absolute inset-2 rounded-full bg-wave-soft" aria-hidden />
        <Icon className="relative size-12 text-wave-deep" strokeWidth={1.6} aria-hidden />
      </div>
      {method === "worldid" ? (
        <>
          <p className="mt-6 text-xl font-bold">Waiting for World ID</p>
          <p className="mt-2 max-w-[17rem] text-[15px] leading-relaxed text-muted">
            Approve the request in World App or the World ID Simulator.
          </p>
          <a
            href={WORLD_ID_SIMULATOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-5 inline-flex h-11 items-center gap-2 rounded-full bg-surface px-5 text-[15px] font-semibold hover:bg-surface-2 ${focusRing}`}
          >
            Open World ID Simulator
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </>
      ) : (
        <>
          <p className="mt-6 text-xl font-bold">Confirm with {METHOD_LABEL[method]}</p>
          <p className="mt-2 max-w-[17rem] text-[15px] leading-relaxed text-muted">
            Your passkey signs this exact transaction on this device.
          </p>
        </>
      )}
    </div>
  );
}

export function DoneView({
  title,
  body,
  onDone,
}: {
  title: string;
  body: string;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col items-center pt-4 text-center" role="status" aria-live="polite">
      <span className="grid size-24 animate-pop-in place-items-center rounded-full bg-wave">
        <CircleCheck className="size-12 text-ink" strokeWidth={1.8} aria-hidden />
      </span>
      <p className="mt-6 text-2xl font-bold tracking-tight">{title}</p>
      <p className="mt-2 max-w-[18rem] text-[15px] leading-relaxed text-muted">{body}</p>
      <div className="mt-8 w-full">
        <PrimaryButton onClick={onDone}>Done</PrimaryButton>
      </div>
    </div>
  );
}
