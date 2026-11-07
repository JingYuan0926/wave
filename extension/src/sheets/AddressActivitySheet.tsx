import { useEffect, useState } from "react";
import { api, errorText, type ActivityItem, type Address } from "../lib/wave";
import { PrimaryButton, Sheet } from "../components/ui";
import { TxLink } from "../components/Approving";

/** The transactions of one address. The local explorer has transaction pages and no address page. */
export function AddressActivitySheet({ address, title, onClose }: { address: string; title: string; onClose: () => void }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .activity(address as Address)
      .then((response) => {
        if (live) setItems(response.items);
      })
      .catch((cause) => {
        if (live) setError(errorText(cause, "WAVE could not read these transactions."));
      });
    return () => {
      live = false;
    };
  }, [address]);

  return (
    <Sheet title={title} onClose={onClose}>
      <p className="break-all font-mono text-sm text-ink-2">{address}</p>
      {error && <p className="mt-4 text-sm font-semibold text-danger">{error}</p>}
      {!error && items === null && <p className="mt-4 text-sm text-muted">Loading…</p>}
      {items?.length === 0 && <p className="mt-4 text-sm text-muted">No transactions yet.</p>}
      {items && items.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {items.map((item) => (
            <li key={item.txHash} className="py-3">
              <p className="text-[15px] font-semibold">{item.title}</p>
              <TxLink hash={item.txHash} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5">
        <PrimaryButton tone="ghost" onClick={onClose}>
          Close
        </PrimaryButton>
      </div>
    </Sheet>
  );
}
