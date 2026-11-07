import type { Tab } from "./components/BottomNav";
import type { TxAction } from "./lib/wave";

export type Sub = "limits" | "methods" | "account";

export type SheetState =
  | { type: "send"; recipientId?: string }
  | { type: "receive" }
  | { type: "scan" }
  | { type: "more" }
  | { type: "addRecipient" }
  | { type: "addAgent" }
  | { type: "cancel"; pendingId: string }
  | { type: "run"; pendingId: string }
  | { type: "agent"; agentId: string }
  | { type: "agentSwitch"; agentId: string }
  | { type: "addressActivity"; address: string; title: string }
  | { type: "saveLimits"; action: TxAction; how: "stricter" | "looser" }
  | { type: "createCard"; kind?: "passkey" | "nfc" }
  | { type: "cards"; holder: "methods" | "agents" };

export type Nav = {
  goTab: (t: Tab) => void;
  openSub: (s: Sub) => void;
  back: () => void;
  openSheet: (s: SheetState) => void;
};
