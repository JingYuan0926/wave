"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type { Address, AgentsResponse } from "@/lib/api-types";

const POLL_MS = 3000;

/** Key the caller on `master`, so that one wallet never shows the agents of another. */
export function useAgents(master: Address) {
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await api.agents(master);
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "WAVE could not read the agent wallets.");
    }
  }, [master]);

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, POLL_MS);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [refresh]);

  return { data, error, refresh };
}
