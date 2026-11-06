import { useEffect, useMemo, useRef, useState } from "react";
import { BottomNav, type Tab } from "./components/BottomNav";
import { PhoneFrame } from "./components/PhoneFrame";
import type { Nav, SheetState, Sub } from "./nav";
import { Home } from "./screens/Home";
import { Agents } from "./screens/Agents";
import { Recipients } from "./screens/Recipients";
import { Payments } from "./screens/Payments";
import { CreateWallet, NotDeployed } from "./screens/Onboarding";
import { useStore } from "./store";
import { AccountDetails, Methods, SpendingLimits } from "./screens/SubPages";
import { SendSheet } from "./sheets/SendSheet";
import { CardsSheet, CreateCardSheet } from "./sheets/CardSheets";
import {
  AddAgentSheet,
  AddRecipientSheet,
  CancelSheet,
  MoreSheet,
  ReceiveSheet,
  ScanSheet,
} from "./sheets/OtherSheets";

const isExtension = typeof location !== "undefined" && location.protocol === "chrome-extension:";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [sub, setSub] = useState<Sub | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const framed = useFramed();
  const { status } = useStore().state;

  useEffect(() => {
    document.body.classList.toggle("is-ext", isExtension);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, sub]);

  const nav: Nav = useMemo(
    () => ({
      goTab: (t) => {
        setSub(null);
        setTab(t);
      },
      openSub: (s) => setSub(s),
      back: () => setSub(null),
      openSheet: (s) => setSheet(s),
    }),
    [],
  );

  const close = () => setSheet(null);

  if (status === "not-deployed" || status === "no-wallet") {
    const first = (
      <div className="relative h-full w-full overflow-y-auto bg-white">{status === "not-deployed" ? <NotDeployed /> : <CreateWallet />}</div>
    );
    return framed ? <PhoneFrame>{first}</PhoneFrame> : <div className="mx-auto h-full w-full max-w-[393px]">{first}</div>;
  }

  const screen = sub
    ? { limits: <SpendingLimits nav={nav} />, methods: <Methods nav={nav} />, account: <AccountDetails nav={nav} /> }[sub]
    : {
        home: <Home nav={nav} />,
        agents: <Agents nav={nav} />,
        recipients: <Recipients nav={nav} />,
        payments: <Payments nav={nav} />,
      }[tab];

  const app = (
    <div className="relative h-full w-full overflow-clip bg-white">
        <main ref={scrollRef} className="no-scrollbar absolute inset-0 overflow-y-auto pb-36" key={sub ?? tab}>
          {screen}
        </main>

        <BottomNav active={tab} onChange={nav.goTab} />

        {sheet?.type === "send" && <SendSheet onClose={close} recipientId={sheet.recipientId} />}
        {sheet?.type === "receive" && <ReceiveSheet onClose={close} />}
        {sheet?.type === "scan" && <ScanSheet onClose={close} onPayRecipient={() => setSheet({ type: "send" })} />}
        {sheet?.type === "more" && <MoreSheet onClose={close} nav={nav} />}
        {sheet?.type === "addRecipient" && <AddRecipientSheet onClose={close} />}
        {sheet?.type === "addAgent" && <AddAgentSheet onClose={close} />}
        {sheet?.type === "cancel" && <CancelSheet pendingId={sheet.pendingId} onClose={close} />}
        {sheet?.type === "createCard" && <CreateCardSheet kind={sheet.kind} onClose={close} />}
        {sheet?.type === "cards" && (
          <CardsSheet
            holder={sheet.holder}
            onClose={close}
            onAdd={() => setSheet(sheet.holder === "methods" ? { type: "createCard" } : { type: "addAgent" })}
          />
        )}
    </div>
  );

  // Extension side panel or a real phone: fill the screen, capped at iPhone 16 width.
  if (!framed) return <div className="mx-auto h-full w-full max-w-[393px]">{app}</div>;
  // Desktop browser preview: exact iPhone 16 frame.
  return <PhoneFrame>{app}</PhoneFrame>;
}

function useFramed() {
  const query = "(min-width: 500px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return !isExtension && wide;
}
