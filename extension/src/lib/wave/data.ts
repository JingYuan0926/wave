import { useCallback, useEffect, useRef, useState } from "react";
import { api, isOffline } from "@/lib/api-client";
import type { AccountResponse, ActivityItem, AgentsResponse, InfoResponse } from "@/lib/api-types";
import { adoptRecoveryPasskey, useLocalState, type LocalState, type LocalWallet } from "@/lib/ui/local";

const POLL_MS = 5000;

export type WaveData = {
  local: LocalState | null;
  wallet: LocalWallet | null;
  info: InfoResponse | null;
  account: AccountResponse | null;
  activity: ActivityItem[] | null;
  agents: AgentsResponse | null;
  /** True after the first load ends, with or without a result. */
  settled: boolean;
  /** The chain or the server does not answer. */
  offline: boolean;
  /** A load failure that is not an offline chain. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Reads only the agent wallets, for a screen that polls them. It throws if the read fails. */
  refreshAgents: () => Promise<void>;
};

/** The same loads as components/wallet-provider.tsx, plus the agent wallets. */
export function useWaveData(): WaveData {
  const local = useLocalState();
  const wallet = local?.wallet ?? null;
  const address = wallet?.address ?? null;
  const plan = wallet?.plan;

  const [info, setInfo] = useState<InfoResponse | null>(null);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const generation = useRef(0);
  const agentRead = useRef(0);

  /** Only the newest read may write, so a slow answer cannot bring back an old approval state. */
  const refreshAgents = useCallback(async () => {
    if (!address) return;
    const mine = ++agentRead.current;
    const next = await api.agents(address);
    if (mine === agentRead.current) setAgents(next);
  }, [address]);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const nextInfo = await api.info();
      if (mine !== generation.current) return;
      // The server answered, so a later failure must not read as an unreachable server.
      setInfo(nextInfo);
      setOffline(!nextInfo.chainOnline);
      const nextAccount = address ? await api.account(address, plan) : null;
      const nextActivity = address ? await api.activity(address) : null;
      if (mine !== generation.current) return;
      // An agent failure must not hide the balance. The old list stays until the next poll.
      if (address) await refreshAgents().catch(() => undefined);
      else setAgents(null);
      if (mine !== generation.current) return;
      setAccount(nextAccount);
      setActivity(nextActivity?.items ?? null);
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
  }, [address, plan, refreshAgents]);

  useEffect(() => {
    if (account?.owner.kind === "passkey" && account.ownerKeyX) {
      adoptRecoveryPasskey(account.address, account.owner.slot, account.ownerKeyX);
    }
  }, [account]);

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

  // Hide data from another wallet while a new address loads.
  const current = account && address && account.address === address ? account : null;

  return {
    local,
    wallet,
    info,
    account: current,
    activity: current ? activity : null,
    agents: current ? agents : null,
    settled,
    offline,
    error,
    refresh: load,
    refreshAgents,
  };
}
