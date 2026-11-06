import type { Tab } from "./components/BottomNav";

export type Sub = "limits" | "methods" | "account";

export type SheetState =
  | { type: "send"; recipientId?: string }
  | { type: "receive" }
  | { type: "scan" }
  | { type: "more" }
  | { type: "addRecipient" }
  | { type: "addAgent" }
  | { type: "cancel"; pendingId: string }
  | { type: "createCard"; kind?: "passkey" | "nfc" }
  | { type: "cards"; holder: "methods" | "agents" };

export type Nav = {
  goTab: (t: Tab) => void;
  openSub: (s: Sub) => void;
  back: () => void;
  openSheet: (s: SheetState) => void;
};
