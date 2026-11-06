"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, isOffline } from "@/lib/api-client";
import type { AccountResponse, ActivityItem, InfoResponse, TokenInfo } from "@/lib/api-types";
import { useLocalState, type LocalState, type LocalWallet } from "@/lib/ui/local";

const POLL_MS = 5000;

type WalletContextValue = {
  /** Null until the browser has read localStorage. */
  local: LocalState | null;
  wallet: LocalWallet | null;
  info: InfoResponse | null;
  account: AccountResponse | null;
  activity: ActivityItem[] | null;
  /** True until the first load ends. */
  loading: boolean;
  offline: boolean;
  /** A load failure that is not an offline chain. */
  error: string | null;
  refresh: () => Promise<void>;
  tokenBy: (address: string) => TokenInfo | undefined;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const local = useLocalState();
  const wallet = local?.wallet ?? null;
  const address = wallet?.address ?? null;

  const [info, setInfo] = useState<InfoResponse | null>(null);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const nextInfo = await api.info();
      const nextAccount = address ? await api.account(address) : null;
      const nextActivity = address ? await api.activity(address) : null;
      if (mine !== generation.current) return;
      setInfo(nextInfo);
      setAccount(nextAccount);
      setActivity(nextActivity?.items ?? null);
      setOffline(!nextInfo.chainOnline);
      setError(null);
    } catch (cause) {
      if (mine !== generation.current) return;
      if (isOffline(cause)) {
        setOffline(true);
        setError(null);
      } else {
        setError(cause instanceof Error ? cause.message : "The request failed.");
      }
    } finally {
      if (mine === generation.current) setSettled(true);
    }
  }, [address]);

  useEffect(() => {
    if (!local) return;
    let active = true;
    const run = () => {
      if (active && document.visibilityState === "visible") void load();
    };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, POLL_MS);
    document.addEventListener("visibilitychange", run);
    return () => {
      active = false;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [local, load]);

  const value = useMemo<WalletContextValue>(() => {
    // Hide data from another wallet while a new address loads.
    const current = account && address && account.address === address ? account : null;
    return {
      local,
      wallet,
      info,
      account: current,
      activity: current ? activity : null,
      loading: !local || !settled,
      offline,
      error,
      refresh: load,
      tokenBy: (token) =>
        info?.tokens.find((item) => item.address.toLowerCase() === token.toLowerCase()),
    };
  }, [local, wallet, info, account, address, activity, settled, offline, error, load]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet needs a WalletProvider.");
  return value;
}
