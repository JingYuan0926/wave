import { Bot } from "lucide-react";
import type { Nav } from "../nav";
import { PageTitle, PrimaryButton, TopBar } from "../components/ui";

/** Agent wallets run on the WAVE frame-transaction network. They are not on Whitechain yet. */
export function Agents({ nav }: { nav: Nav }) {
  return (
    <>
      <TopBar />
      <PageTitle sub="AI agents can pay for you, inside the limits you set.">Agents</PageTitle>

      <div className="mx-5 flex flex-col items-center rounded-[24px] border border-dashed border-line px-6 py-10 text-center">
        <Bot className="size-8 text-muted" aria-hidden />
        <p className="mt-3 font-semibold">Not on Whitechain yet</p>
        <p className="mt-1 text-sm leading-snug text-muted">
          Agent wallets, with their own budgets and keys, run on the WAVE frame-transaction network. On Whitechain your
          wallet sends and receives payments with your passkey.
        </p>
      </div>

      <div className="px-5 pt-5">
        <PrimaryButton tone="ghost" onClick={() => nav.goTab("home")}>
          Back to wallet
        </PrimaryButton>
      </div>
    </>
  );
}
