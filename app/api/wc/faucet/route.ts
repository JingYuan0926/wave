import { faucet } from "@/lib/server/wc-relayer";
import { wcOptions, wcPost } from "@/lib/server/wc-route";
import { requireLocal } from "@/lib/server/http";

// SAMPLE: Whitechain Sepolia. Mints 500 WAVE test USDT (tUSDT) to a wallet, once a day. The relayer
// pays the gas and gets nothing back, so this route accepts local callers only.
export const POST = wcPost(faucet, requireLocal);
export const OPTIONS = wcOptions;
