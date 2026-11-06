import { send } from "@/lib/server/wc-relayer";
import { wcOptions, wcPost } from "@/lib/server/wc-route";

// Whitechain Sepolia: submits a signed WAVE user operation to EntryPoint v0.7 and reports the result.
export const POST = wcPost(send);
export const OPTIONS = wcOptions;
