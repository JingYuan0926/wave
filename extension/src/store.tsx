import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { RECIPIENTS, type Agent, type MethodCard, type Pending, type Recipient, type Tx, type Wallet } from "./data";
import {
  dailyStop,
  errorText,
  liveDaily,
  plainName,
  rankChoices,
  spendRule,
  toAgent,
  toCards,
  toPending,
  toTx,
  toWallet,
  tokenRules,
  useApproval,
  useWaveData,
  visibleActivity,
  type AccountResponse,
  type AgentNames,
  type AgentsResponse,
  type ApprovalContext,
  type InfoResponse,
  type LocalState,
  type LocalWallet,
  type MethodRef,
  type MethodView,
  type TokenInfo,
  type TxAction,
} from "./lib/wave";

/**
 * `no-wallet` shows the first-run screen. `unreachable` means that the WAVE server gave no answer,
 * so nothing is known about the chain.
 */
export type Status = "loading" | "unreachable" | "no-wallet" | "ready";

/** What the UI holds itself. The chain holds all the rest. */
type UiState = {
  recipients: Recipient[];
  agentNames: AgentNames;
  /** The card (method or agent budget) added most recently, so its holder can animate it in. */
  newCardId: string | null;
  promoDismissed: boolean;
  /** A real warning that must stay after a sheet closes. It stays until the owner closes it. */
  notice: string | null;
};

export type State = UiState & {
  status: Status;
  wallet: Wallet;
  cards: MethodCard[];
  transactions: Tx[];
  pending: Pending[];
  agents: Agent[];
  /** The raw WAVE data, for the screens that need more than the shapes above. */
  local: LocalState | null;
  localWallet: LocalWallet | null;
  info: InfoResponse | null;
  account: AccountResponse | null;
  agentData: AgentsResponse | null;
  offline: boolean;
  /** The last read error, shown as a banner. The next good read clears it. */
  error: string | null;
};

const uid = () => Math.random().toString(36).slice(2, 10);

const AGENT_NAMES_KEY = "wave.agent-names.v1";

function readAgentNames(): AgentNames {
  try {
    return JSON.parse(window.localStorage.getItem(AGENT_NAMES_KEY) ?? "{}") as AgentNames;
  } catch {
    return {};
  }
}

function saveAgentNames(names: AgentNames) {
  try {
    window.localStorage.setItem(AGENT_NAMES_KEY, JSON.stringify(names));
  } catch {
    // A private window can block storage. The name then lasts until a reload.
  }
}

function useStoreState() {
  const data = useWaveData();
  const { local, wallet, info, account, activity, agents, settled, offline, error, refresh, refreshAgents } = data;
  const [ui, setUi] = useState<UiState>({
    // SAMPLE: no WAVE function yet. WAVE has no address book, so the list lives in this tab.
    recipients: RECIPIENTS,
    // SAMPLE: no WAVE function yet. WAVE stores no agent name, so this browser keeps it.
    agentNames: readAgentNames(),
    newCardId: null,
    promoDismissed: false,
    notice: null,
  });

  const state = useMemo<State>(() => {
    const status: Status = !settled
      ? "loading"
      : !info
        ? "unreachable"
        : !wallet
          ? "no-wallet"
          : "ready";
    return {
      ...ui,
      status,
      wallet: toWallet(wallet, account, info),
      cards: toCards(account, info, wallet, local),
      transactions: info && activity ? visibleActivity(activity, info).map((item) => toTx(item, info, ui.recipients)) : [],
      pending: account ? account.pending.map((action) => toPending(action, info)) : [],
      agents: agents
        ? agents.agents.map((view, index) => toAgent(view, index, info, account?.pending ?? [], ui.agentNames))
        : [],
      local,
      localWallet: wallet,
      info,
      account,
      agentData: agents,
      offline,
      error,
    };
  }, [ui, settled, info, wallet, account, activity, agents, local, offline, error]);

  const actions = useMemo(
    () => ({
      refresh,
      refreshAgents,
      notify: (notice: string) => setUi((s) => ({ ...s, notice })),
      dismissNotice: () => setUi((s) => ({ ...s, notice: null })),
      dismissPromo: () => setUi((s) => ({ ...s, promoDismissed: true })),
      addRecipient: (r: Omit<Recipient, "id">) =>
        setUi((s) => ({ ...s, recipients: [{ ...r, id: uid() }, ...s.recipients] })),
      nameAgent: (address: string, label: AgentNames[string]) =>
        setUi((s) => {
          const agentNames = { ...s.agentNames, [address.toLowerCase()]: label };
          saveAgentNames(agentNames);
          return { ...s, agentNames };
        }),
      /** Plays the "drop into the holder" animation for this card. */
      flagNewCard: (id: string) => setUi((s) => ({ ...s, newCardId: id })),
    }),
    [refresh, refreshAgents],
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

/** The real approval of one action, with the wallet of this store. */
export function useWaveApproval(action: TxAction | null, onAccepted?: ApprovalContext["onAccepted"]) {
  const { state, refresh } = useStore();
  const { localWallet: wallet, account } = state;
  const context: ApprovalContext | null = wallet && account ? { wallet, account, refresh, onAccepted } : null;
  return useApproval(action, context);
}

type LateRequest = { action: TxAction; method: MethodRef; onAccepted?: ApprovalContext["onAccepted"] };

/**
 * For an action that exists only after a click, such as a new passkey. The approval starts when the
 * action arrives. After a retry the stage is idle, and the screen shows the method buttons again.
 */
export function useLateApproval() {
  const [request, setRequest] = useState<LateRequest | null>(null);
  const approval = useWaveApproval(request?.action ?? null, request?.onAccepted);
  const { approveNow } = approval;
  // The engine reads the action of the last render, so this must run after that render.
  // The sheet already showed what the owner approves, so this goes straight to the device or the scan.
  useLayoutEffect(() => {
    if (request) void approveNow(request.method);
  }, [request, approveNow]);
  return { approval, request, begin: setRequest };
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

/**
 * The rule check of components/send-flow.tsx for one send from the main wallet. It gives the methods
 * that may approve this amount, and the reason if a rule stops it.
 */
export function useSpendCheck(token: TokenInfo | undefined, units: bigint | null) {
  const { account, info, local, localWallet: wallet } = useStore().state;
  const now = useNow(1000);
  const nameOf = (view: MethodView) => plainName(view, wallet, local, info?.world);
  const rule = account && token && units !== null ? spendRule(account, token.address, units, nameOf) : null;
  const ranked = rule ? rankChoices(rule.choices.filter((choice) => choice.allowed), wallet, local, info) : [];
  // The chain lets the owner method approve every amount. The page offers the method the person chose for this amount.
  const chosen = ranked.filter((choice) => !choice.view.owner);
  const allowed = chosen.length > 0 ? chosen : ranked;
  // The daily window has an end in seconds. The clock of this sheet counts in milliseconds.
  const daily = account && token ? liveDaily(tokenRules(account, token.address)?.daily, Math.floor(now / 1000)) : null;
  const stop = token && units !== null ? dailyStop(daily, units, token) : null;
  const noMethod = rule && allowed.length === 0 ? rule.summary : null;
  return { nameOf, rule, allowed, daily, stop, noMethod };
}

const AGENTS_POLL_MS = 1000;

/**
 * Reads the agent wallets each second, so a World ID approval shows at once. So a payment from
 * Claude Code shows with no reload. It returns the last read error, or null.
 */
export function useAgentPolling() {
  const { refreshAgents } = useStore();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let reading = false;
    const run = () => {
      // A slow read must not stack up behind the next one.
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      refreshAgents()
        .then(
          () => setError(null),
          (cause: unknown) => setError(errorText(cause, "WAVE could not read the agent wallets.")),
        )
        .finally(() => {
          reading = false;
        });
    };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, AGENTS_POLL_MS);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [refreshAgents]);

  return error;
}
