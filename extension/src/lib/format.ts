import type { Token } from "../data";

export function fmtToken(amount: number, token: Token) {
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n} ${token}`;
}

export function fmtUsd(amount: number) {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtCountdown(ms: number) {
  if (ms <= 0) return "Ready";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}:${String(s).padStart(2, "0")} left`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}
