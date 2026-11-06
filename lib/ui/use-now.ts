"use client";

import { useSyncExternalStore } from "react";

let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    current = Math.floor(Date.now() / 1000);
    timer = setInterval(() => {
      current = Math.floor(Date.now() / 1000);
      listeners.forEach((notify) => notify());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The Unix time in seconds, updated each second. 0 during the server render. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => current || Math.floor(Date.now() / 1000),
    () => 0,
  );
}
