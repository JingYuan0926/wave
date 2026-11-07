import { useState } from "react";
import { ChevronRight, Plus, Search, X } from "lucide-react";
import { shortAddr } from "../lib/format";
import { useStore } from "../store";
import type { Nav } from "../nav";
import { Avatar, PageTitle, Pill, TopBar, focusRing } from "../components/ui";

// SAMPLE: no WAVE function yet. WAVE has no address book. A row opens the real SendSheet.
export function Recipients({ nav }: { nav: Nav }) {
  const { state } = useStore();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const list = state.recipients.filter(
    (r) =>
      !query ||
      r.name.toLowerCase().includes(query) ||
      r.handle?.toLowerCase().includes(query) ||
      r.address.toLowerCase().includes(query),
  );

  return (
    <>
      <TopBar
        right={
          <Pill tone="accent" trailingIcon={Plus} onClick={() => nav.openSheet({ type: "addRecipient" })}>
            Add
          </Pill>
        }
      />
      <PageTitle>Recipients</PageTitle>

      <div className="px-5">
        <label htmlFor="recipient-search" className="sr-only">
          Search recipients
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id="recipient-search"
            type="search"
            autoComplete="off"
            placeholder="Name, ENS or address"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-12 w-full rounded-full bg-surface pl-12 pr-12 text-base outline-none ring-wave-deep placeholder:text-muted focus-visible:ring-2"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label="Clear search"
              className={`absolute right-1.5 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full hover:bg-surface-2 ${focusRing}`}
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </div>

      <h2 className="mx-5 mt-6 border-b border-line pb-3 text-[15px] font-medium text-ink-2">
        {query ? `${list.length} result${list.length === 1 ? "" : "s"}` : "Everyone you've paid"}
      </h2>

      {list.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="font-semibold">No one matches “{q}”</p>
          <p className="mt-1 text-sm text-muted">Check the spelling, or add them as a new recipient.</p>
          <button
            type="button"
            onClick={() => nav.openSheet({ type: "addRecipient" })}
            className={`mt-4 h-11 rounded-full bg-wave-soft px-5 text-[15px] font-semibold hover:bg-wave ${focusRing}`}
          >
            Add recipient
          </button>
        </div>
      ) : (
        <ul className="mt-1">
          {list.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => nav.openSheet({ type: "send", recipientId: r.id })}
                className={`flex w-full items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-surface ${focusRing}`}
              >
                <Avatar name={r.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[17px] font-semibold">{r.name}</span>
                  <span className="block truncate font-mono text-sm text-muted">{r.handle ?? shortAddr(r.address)}</span>
                </span>
                <span className="sr-only">Send money</span>
                <ChevronRight className="size-5 shrink-0" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
