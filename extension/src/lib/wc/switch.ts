// The Whitechain payments switch. It is off by default. With the switch off, this file makes no
// network call, and the app runs the normal send.
import { useSyncExternalStore } from "react";
import { fetchStatus, type WcDeployment } from "./config";

const STORAGE_KEY = "wave.wc.payments";

/** "on" needs the switch and a good server answer. "checking" waits for that answer. */
export type WhitechainState = {
  mode: "off" | "checking" | "on";
  /** Why the switch stays off. */
  reason: string | null;
  deployment: WcDeployment | null;
};

const OFF: WhitechainState = { mode: "off", reason: null, deployment: null };

function wasTurnedOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The switch then lasts until the page reloads.
  }
}

let state = OFF;
let run = 0;
const listeners = new Set<() => void>();

function publish(next: WhitechainState) {
  state = next;
  listeners.forEach((listener) => listener());
}

async function check() {
  run += 1;
  const mine = run;
  publish({ mode: "checking", reason: null, deployment: null });
  const status = await fetchStatus();
  if (mine !== run) return;
  if (status.ready) {
    remember(true);
    publish({ mode: "on", reason: null, deployment: status.deployment });
  } else {
    publish({ mode: "off", reason: status.reason, deployment: null });
  }
}

export function turnOnWhitechain() {
  void check();
}

export function turnOffWhitechain() {
  run += 1;
  remember(false);
  publish(OFF);
}

// A failed check at start keeps the stored choice. The switch shows off and the reason.
if (wasTurnedOn()) void check();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWhitechainPayments(): WhitechainState {
  return useSyncExternalStore(subscribe, () => state);
}
