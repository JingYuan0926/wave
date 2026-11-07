import { wcStatus } from "@/lib/server/wc-relayer";
import { wcGet, wcOptions } from "@/lib/server/wc-route";

// Whitechain Sepolia: says if a send can work now, and gives the public deployment values.
export const GET = wcGet(wcStatus);
export const OPTIONS = wcOptions;
