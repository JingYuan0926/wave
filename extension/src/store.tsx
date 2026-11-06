import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AGENTS,
  METHOD_CARDS,
  PENDING,
  RECIPIENTS,
  TRANSACTIONS,
  WALLET,
  type Agent,
  type CardDesign,
  type MethodCard,
  type Pending,
  type Recipient,
  type Token,
  type Tx,
  type Wallet,
} from "./data";

type State = {
  wallet: Wallet;
  cards: MethodCard[];
  transactions: Tx[];
  pending: Pending[];
  recipients: Recipient[];
  agents: Agent[];
  /** The card (method or agent budget) added most recently, so its holder can animate it in. */
  newCardId: string | null;
  hideBalance: boolean;
  promoDismissed: boolean;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const DESIGNS: CardDesign[] = ["coral", "mint", "dusk", "ocean", "night"];

function useStoreState() {
  const [state, setState] = useState<State>({
    wallet: WALLET,
    cards: METHOD_CARDS,
    transactions: TRANSACTIONS,
    pending: PENDING,
    recipients: RECIPIENTS,
    agents: AGENTS,
    newCardId: null,
    hideBalance: false,
    promoDismissed: false,
  });

  const actions = useMemo(
    () => ({
      toggleHide: () => setState((s) => ({ ...s, hideBalance: !s.hideBalance })),
      dismissPromo: () => setState((s) => ({ ...s, promoDismissed: true })),
      addTx: (tx: Omit<Tx, "id">) =>
        setState((s) => ({ ...s, transactions: [{ ...tx, id: uid() }, ...s.transactions] })),
      debit: (token: Token, amount: number) =>
        setState((s) => ({
          ...s,
          wallet: { ...s.wallet, balances: { ...s.wallet.balances, [token]: s.wallet.balances[token] - amount } },
        })),
      addPending: (p: Omit<Pending, "id">) =>
        setState((s) => ({ ...s, pending: [...s.pending, { ...p, id: uid() }] })),
      removePending: (id: string) => setState((s) => ({ ...s, pending: s.pending.filter((p) => p.id !== id) })),
      addRecipient: (r: Omit<Recipient, "id">) =>
        setState((s) => ({ ...s, recipients: [{ ...r, id: uid() }, ...s.recipients] })),

      /** Adds a method card. Returns its id. It is not flagged as new until `flagNewCard`. */
      addMethodCard: (c: Omit<MethodCard, "id">) => {
        const id = uid();
        setState((s) => ({ ...s, cards: [...s.cards, { ...c, id }] }));
        return id;
      },
      activateCard: (id: string) =>
        setState((s) => ({ ...s, cards: s.cards.map((c) => (c.id === id ? { ...c, activeAt: Date.now() } : c)) })),
      removeCard: (id: string) => setState((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== id) })),
      /** Plays the "drop into the holder" animation for this card. */
      flagNewCard: (id: string) => setState((s) => ({ ...s, newCardId: id })),

      addAgent: (a: Omit<Agent, "id" | "design">) => {
        const id = uid();
        setState((s) => ({
          ...s,
          agents: [...s.agents, { ...a, id, design: DESIGNS[s.agents.length % DESIGNS.length] }],
          newCardId: id,
        }));
        return id;
      },
      toggleAgent: (id: string) =>
        setState((s) => ({
          ...s,
          agents: s.agents.map((a) => (a.id === id ? { ...a, active: !a.active } : a)),
        })),
    }),
    [],
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
