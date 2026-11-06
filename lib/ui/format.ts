/**
 * Display formatting. These functions use BigInt, so a value never passes
 * through a float and never prints in scientific notation.
 */

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const MAX_FRACTION = 4;
const SIGNIFICANT = 3;

function toSubscript(value: number): string {
  return String(value)
    .split("")
    .map((digit) => SUBSCRIPT[Number(digit)])
    .join("");
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function parseBase(value: string | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function split(value: bigint, decimals: number): { whole: string; fraction: string } {
  const text = value.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return { whole: text, fraction: "" };
  return {
    whole: text.slice(0, -decimals),
    fraction: text.slice(-decimals).replace(/0+$/, ""),
  };
}

export type ParsedAmount = { value: bigint; error: null } | { value: null; error: string };

/**
 * Reads a typed amount. It never rounds and never guesses: text it cannot read exactly is an
 * error, so a typo cannot turn into another amount.
 */
export function parseTokenAmount(text: string, decimals: number): ParsedAmount {
  const trimmed = text.trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) {
    return { value: null, error: "Enter a number, such as 12.5." };
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    return { value: null, error: `This token has ${decimals} decimals. Enter fewer digits.` };
  }
  return { value: BigInt(`${whole}${fraction.padEnd(decimals, "0")}` || "0"), error: null };
}

/** The exact value with no rounding. Use it for titles, labels and inputs. */
export function plainAmount(
  value: string | bigint | null | undefined,
  decimals: number,
): string {
  const parsed = parseBase(value);
  if (parsed === null || parsed < BigInt(0)) return "--";
  const { whole, fraction } = split(parsed, decimals);
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The display value. It rounds down, so a balance never shows more than it holds.
 * A value with 3 or more leading zeros uses the subscript form: 0.0₄58.
 */
export function formatAmount(
  value: string | bigint | null | undefined,
  decimals: number,
): string {
  const parsed = parseBase(value);
  if (parsed === null || parsed < BigInt(0)) return "--";
  if (parsed === BigInt(0)) return "0";

  const { whole, fraction } = split(parsed, decimals);
  if (whole === "0") {
    const zeros = fraction.length - fraction.replace(/^0+/, "").length;
    if (zeros >= 3) {
      const digits = fraction.slice(zeros, zeros + SIGNIFICANT).replace(/0+$/, "");
      return `0.0${toSubscript(zeros)}${digits}`;
    }
  }
  const shown = fraction.slice(0, MAX_FRACTION).replace(/0+$/, "");
  return shown ? `${groupThousands(whole)}.${shown}` : groupThousands(whole);
}

/** Middle shortening for addresses and hashes. It keeps both ends. */
export function shortHex(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/** Plain text for a length of time: "48 hours", "2 minutes", "90 seconds". */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "None";
  if (seconds === 604800) return "7 days";
  if (seconds % 604800 === 0) return plural(seconds / 604800, "week");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** The delay text with a demo limit, for example "Demo delay: 2 minutes (real: 24 hours)". */
export function delayText(real: number, limit: number): string {
  const applied = limit > 0 ? Math.min(real, limit) : real;
  if (applied >= real) return formatDuration(real);
  return `Demo delay: ${formatDuration(applied).toLowerCase()} (real: ${formatDuration(real).toLowerCase()})`;
}

/** The unit in "300 USDC per day". */
export function formatPeriod(seconds: number): string {
  if (seconds === 86400) return "day";
  if (seconds === 604800) return "week";
  return formatDuration(seconds).toLowerCase();
}

/** A running clock: "1:59" or "47:59:58". */
export function formatCountdown(seconds: number): string {
  const left = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const rest = String(left % 60).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
  }
  return `${minutes}:${rest}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
