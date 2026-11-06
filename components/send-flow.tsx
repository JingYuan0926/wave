"use client";

import { useMemo, useState } from "react";
import { isAddress } from "viem";
import { ETH_TOKEN, type Address } from "@/lib/api-types";
import { formatAmount, parseTokenAmount } from "@/lib/ui/format";
import { ETH_GAS_RESERVE, describeSpend } from "@/lib/ui/rules";
import { ApproveFlow, MethodPicker, type ApprovalRequest } from "./approve-flow";
import { Amount, Button, Field, Notice, SelectField, Sheet } from "./ui";
import { useWallet } from "./wallet-provider";

export function SendFlow({ onClose, initialTo = "" }: { onClose: () => void; initialTo?: string }) {
  const { account, info, tokenBy } = useWallet();
  const [to, setTo] = useState(initialTo);
  const [amountText, setAmountText] = useState("");
  const [tokenAddress, setTokenAddress] = useState<string>(
    () => info?.tokens.find((t) => t.isTest)?.address ?? info?.tokens[0]?.address ?? "",
  );
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  const token = tokenBy(tokenAddress);
  const parsed = token && amountText ? parseTokenAmount(amountText, token.decimals) : null;
  const amount = parsed?.value ? parsed.value : null;
  // Strict mode checks the checksum of a mixed-case address. A failed check means a typo.
  const toValid = isAddress(to);
  const badChecksum = !toValid && isAddress(to, { strict: false });
  const toSelf = toValid && to.toLowerCase() === account?.address.toLowerCase();
  const balance = BigInt(
    account?.balances.find((b) => b.token === token?.address)?.amount ?? "0",
  );
  const tooMuch = amount !== null && amount > balance;
  // A wallet with no sponsor pays gas first, so a full ETH balance cannot arrive.
  const gasReserve = info?.gasSponsored ? BigInt(0) : ETH_GAS_RESERVE;
  const noGas = !tooMuch && token?.address === ETH_TOKEN && amount !== null && amount + gasReserve > balance;

  const rule = useMemo(() => {
    if (!account || !token || amount === null) return null;
    const rules = account.rules.find((r) => r.token === token.address);
    return describeSpend(rules, amount, account.methods, account.demoDelay);
  }, [account, token, amount]);

  if (!account || !info) return null;

  if (request) {
    return (
      <Sheet title="Approve transfer" onClose={onClose}>
        <ApproveFlow request={request} />
      </Sheet>
    );
  }

  const toReady = toValid && !toSelf;
  const amountReady = amount !== null && !tooMuch && !noGas;
  const ready = toReady && amountReady && token && rule;

  return (
    <Sheet title="Send" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <Field
          label="To"
          name="to"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          error={
            badChecksum
              ? "This address has a wrong checksum. Check it for a typo."
              : to && !toValid
                ? "Enter a valid address."
                : toSelf
                  ? "The wallet cannot send to itself."
                  : null
          }
        />
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <Field
            label="Amount"
            name="amount"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            placeholder="0.00"
            autoComplete="off"
            inputMode="decimal"
            error={
              parsed?.error
                ? parsed.error
                : amountText && amount === null
                  ? "Enter an amount above 0."
                  : tooMuch
                    ? "This is more than your balance."
                    : noGas
                      ? `Leave about ${formatAmount(gasReserve, 18)} ETH for gas.`
                      : null
            }
          />
          <SelectField
            label="Token"
            name="token"
            value={tokenAddress}
            onChange={(event) => setTokenAddress(event.target.value as Address)}
          >
            {info.tokens.map((item) => (
              <option key={item.address} value={item.address}>
                {item.isTest ? item.name : item.symbol}
              </option>
            ))}
          </SelectField>
        </div>
        {token ? (
          <p className="text-sm text-muted-foreground">
            Balance:{" "}
            <Amount value={balance.toString()} decimals={token.decimals} symbol={token.symbol} />
          </p>
        ) : null}

        {rule ? (
          <>
            <Notice tone={rule.kind === "none" ? "warning" : "info"} title={rule.summary} />
            <div>
              <h3 className="mb-1 text-sm font-medium">Pick a method</h3>
              {ready ? (
                <MethodPicker
                  choices={rule.choices}
                  onPick={(method) =>
                    setRequest({
                      action: {
                        kind: "transfer",
                        token: token.address,
                        to: to as Address,
                        amount: (amount as bigint).toString(),
                      },
                      choices: rule.choices,
                      method,
                    })
                  }
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {toReady ? "Fix the amount first." : "Enter a valid address first."}
                </p>
              )}
            </div>
          </>
        ) : null}

        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </form>
    </Sheet>
  );
}
