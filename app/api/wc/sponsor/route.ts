import { sponsor } from "@/lib/server/wc-relayer";
import { wcOptions, wcPost } from "@/lib/server/wc-route";

// Whitechain Sepolia: checks a WAVE user operation and signs the paymaster data.
export const POST = wcPost(sponsor);
export const OPTIONS = wcOptions;
