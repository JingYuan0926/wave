import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { TOKEN_ORDER, type Agent, type MethodCard, type Pending, type Recipient, type Token, type Tx, type Wallet } from "./data";
import { WC, txUrl } from "./lib/wc/config";
import { createPasskey, loadPasskey, type StoredPasskey } from "./lib/wc/passkey";
import {
  isDeployed,
  readActivity,
  readBalances,
  readPending,
  readTiers,
  walletAddress,
  type ChainTier,
} from "./lib/wc/wallet";
import { shortAddr } from "./lib/format";

export type Status = "not-deployed" | "no-wallet" | "loading" | "ready";

type State = {
  status: Status;
  passkey: StoredPasskey | null;
  wallet: Wallet;
  /** False until the first transaction deploys the account. It can receive tokens before that. */
  deployed: boolean;
  cards: MethodCard[];
  transactions: Tx[];
  pending: Pending[];
  recipients: Recipient[];
  agents: Agent[];
  tiers: Partial<Record<Token, ChainTier[]>>;
  /** The card added most recently, so its holder can animate it in. */
  newCardId: string | null;
  hideBalance: boolean;
  promoDismissed: boolean;
  /** The last read error, shown as a banner. Cleared by the next good read. */
  error: string | null;
};

const RECIPIENTS_KEY = "wave.wc.recipients";
const uid = () => Math.random().toString(36).slice(2, 10);
const EMPTY_BALANCES = Object.fromEntries(TOKEN_ORDER.map((t) => [t, 0])) as Record<Token, number>;
/** On Whitechain the wallet's one method is the owner passkey. */
const PASSKEY_CARD: MethodCard = { id: "passkey", kind: "faceid", design: "navy", activeAt: 0 };

function loadRecipients(): Recipient[] {
  try {
    return JSON.parse(localStorage.getItem(RECIPIENTS_KEY) ?? "[]") as Recipient[];
  } catch {
    return [];
  }
}

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

function useStoreState() {
  const [state, setState] = useState<State>(() => {
    const passkey = loadPasskey();
    return {
      status: !WC ? "not-deployed" : passkey ? "loading" : "no-wallet",
      passkey,
      wallet: { name: "Main wallet", address: "", balances: EMPTY_BALANCES },
      deployed: false,
      cards: passkey ? [PASSKEY_CARD] : [],
      transactions: [],
      pending: [],
      recipients: loadRecipients(),
      agents: [],
      tiers: {},
      newCardId: null,
      hideBalance: false,
      promoDismissed: false,
      error: null,
    };
  });

  const passkeyRef = useRef(state.passkey);
  passkeyRef.current = state.passkey;

  const refresh = useCallback(async () => {
    const passkey = passkeyRef.current;
    if (!WC || !passkey) return;
    try {
      const address = (await walletAddress(passkey)) as Address;
      const [deployed, balances] = await Promise.all([isDeployed(address), readBalances(address)]);
      const [tiers, activity, pending] = await Promise.all([
        readTiers(address, deployed),
        readActivity(address).catch(() => null),
        deployed ? readPending(address).catch(() => null) : Promise.resolve([]),
      ]);
      const names = new Map(loadRecipients().map((r) => [r.address.toLowerCase(), r.name]));
      const nameOf = (a: string) => names.get(a.toLowerCase()) ?? shortAddr(a);
      setState((s) => ({
        ...s,
        status: "ready",
        deployed,
        wallet: { ...s.wallet, address, balances: { ...EMPTY_BALANCES, ...balances } as Record<Token, number> },
        tiers: tiers as Partial<Record<Token, ChainTier[]>>,
        transactions:
          activity === null
            ? s.transactions
            : activity.map((a) => ({
                id: `${a.hash}-${a.direction}-${a.token.symbol}`,
                kind: a.direction,
                title: a.direction === "out" ? `To ${nameOf(a.counterparty)}` : `From ${nameOf(a.counterparty)}`,
                subtitle: `${a.direction === "out" ? "Passkey · " : ""}${when(a.timestamp)}`,
                amount: a.amount,
                token: a.token.symbol,
                method: a.direction === "out" ? "faceid" : undefined,
                href: txUrl(a.hash),
              })),
        pending:
          pending === null
            ? s.pending
            : pending.map((p) => {
                const t = p.transfers[0];
                return {
                  id: p.id,
                  title: t ? `Send ${t.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${t.token.symbol}` : "Queued action",
                  detail: t ? `To ${nameOf(t.to)}` : `${p.transfers.length} calls`,
                  proposedBy: "faceid",
                  endsAt: p.notBefore,
                  cancelBy: ["faceid"],
                  transfer: t ? { token: t.token.symbol, amount: t.amount, to: nameOf(t.to) } : undefined,
                  batch: p.batch,
                } satisfies Pending;
              }),
        error: null,
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        status: s.status === "loading" ? "ready" : s.status,
        error: e instanceof Error ? e.message.split("\n")[0] : "Could not read Whitechain Sepolia.",
      }));
    }
  }, []);

  // Read on start and every 15 seconds while a wallet exists.
  useEffect(() => {
    if (!state.passkey || !WC) return;
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [state.passkey, refresh]);

  const actions = useMemo(
    () => ({
      refresh,
      /** Creates the owner passkey. The wallet address follows from it and the setup rules. */
      createWallet: async () => {
        const passkey = await createPasskey("WAVE wallet");
        setState((s) => ({ ...s, passkey, status: "loading", cards: [PASSKEY_CARD], newCardId: PASSKEY_CARD.id }));
      },
      toggleHide: () => setState((s) => ({ ...s, hideBalance: !s.hideBalance })),
      dismissPromo: () => setState((s) => ({ ...s, promoDismissed: true })),
      /** Shows a transfer at once. The next read replaces it with the indexed one. */
      addTx: (tx: Omit<Tx, "id">) => setState((s) => ({ ...s, transactions: [{ ...tx, id: uid() }, ...s.transactions] })),
      removePending: (id: string) => setState((s) => ({ ...s, pending: s.pending.filter((p) => p.id !== id) })),
      addRecipient: (r: Omit<Recipient, "id">) =>
        setState((s) => {
          const recipients = [{ ...r, id: uid() }, ...s.recipients];
          localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(recipients));
          return { ...s, recipients };
        }),
      /** Plays the "drop into the holder" animation for this card. */
      flagNewCard: (id: string) => setState((s) => ({ ...s, newCardId: id })),
    }),
    [refresh],
  );

  return { state, ...actions };
}

type Store = ReturnType<typeof useStoreState>;
const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = useStoreState();
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

/** Current time, refreshed on an interval. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Hours until a method card can approve, or 0 when it is active. */
export function hoursLeft(card: MethodCard, now: number) {
  return Math.max(0, Math.ceil((card.activeAt - now) / 3_600_000));
}
