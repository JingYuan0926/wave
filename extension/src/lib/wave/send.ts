import { isAddress, zeroAddress } from "viem";
import type { AccountResponse, Address, MethodView } from "@/lib/api-types";
import { describeSpend } from "@/lib/ui/rules";

/** The logic of components/send-flow.tsx, with no UI. All amounts stay in base units. */

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const tokenBalance = (account: AccountResponse, token: Address) =>
  BigInt(account.balances.find((balance) => sameAddress(balance.token, token))?.amount ?? "0");

export const tokenRules = (account: AccountResponse, token: Address) =>
  account.rules.find((rules) => sameAddress(rules.token, token));

/**
 * The rule for one amount. The delay of a tier is the owner's own rule, so the chosen wait of the
 * wallet does not shorten it. WavePolicy._schedule uses the full tier delay.
 */
export function spendRule(account: AccountResponse, token: Address, amount: bigint, nameOf: (view: MethodView) => string) {
  return describeSpend(tokenRules(account, token), amount, account.methods, nameOf);
}

/** Why WAVE must not send to this address, or null if the address can receive. */
export function recipientProblem(address: string, wallet: Address): string | null {
  if (address === zeroAddress) {
    return "This recipient has only an ENS name, and WAVE cannot read ENS names. Add a 0x address.";
  }
  // Strict mode checks the checksum of a mixed-case address. A failed check means a typo.
  if (!isAddress(address)) {
    return isAddress(address, { strict: false }) ? "This address has a wrong checksum. Check it for a typo." : "This address is not valid.";
  }
  return sameAddress(address, wallet) ? "The wallet cannot send to itself." : null;
}
