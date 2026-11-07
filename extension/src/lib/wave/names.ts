import { methodLabel as fullLabel, nameFor as fullFor, plainName as fullName } from "@/lib/ui/rules";

/** A first passkey is "Passkey", and only a second one has a number. */
const short = (name: string) => (name === "Passkey 1" ? "Passkey" : name);

export const plainName = (...args: Parameters<typeof fullName>) => short(fullName(...args));
export const nameFor = (...args: Parameters<typeof fullFor>) => short(fullFor(...args));
export const methodLabel = (...args: Parameters<typeof fullLabel>) => short(fullLabel(...args));
