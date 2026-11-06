import { faucet } from "@/lib/server/wc-relayer";
import { wcOptions, wcPost } from "@/lib/server/wc-route";

// Whitechain Sepolia: mints 500 WAVE test USDT (tUSDT) to a wallet, once a day. The relayer pays the gas.
export const POST = wcPost(faucet);
export const OPTIONS = wcOptions;
