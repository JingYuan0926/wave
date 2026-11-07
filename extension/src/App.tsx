import { useEffect, useMemo, useRef, useState } from "react";
import { BottomNav, type Tab } from "./components/BottomNav";
import { PhoneFrame } from "./components/PhoneFrame";
import { StatusBanner } from "./components/StatusBanner";
import type { Nav, SheetState, Sub } from "./nav";
import { useAgentPolling, useStore } from "./store";
import { Home } from "./screens/Home";
import { Agents } from "./screens/Agents";
import { Recipients } from "./screens/Recipients";
import { Connecting, CreateWallet, NotReachable } from "./screens/Onboarding";
import { Payments } from "./screens/Payments";
import { AccountDetails, Methods, SpendingLimits } from "./screens/SubPages";
import { AgentSheet } from "./sheets/AgentSheet";
import { AddressActivitySheet } from "./sheets/AddressActivitySheet";
import { SendSheet } from "./sheets/SendSheet";
import { CardsSheet, CreateCardSheet } from "./sheets/CardSheets";
import {
  AddAgentSheet,
  AddRecipientSheet,
  AgentSwitchSheet,
  CancelSheet,
  MoreSheet,
  ReceiveSheet,
  RunSheet,
  SaveLimitsSheet,
  ScanSheet,
} from "./sheets/OtherSheets";

const isExtension = typeof location !== "undefined" && location.protocol === "chrome-extension:";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [sub, setSub] = useState<Sub | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const framed = useFramed();
  const { state } = useStore();
  const { status } = state;

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

  // World ID passed for a payment, so the only step left is Confirm. Open it once, with no search.
  useAgentPolling();
  const shown = useRef(new Set<string>());
  const toConfirm = state.agentData?.operations.find((item) => item.status === "needs-confirmation" && !shown.current.has(item.id));
  useEffect(() => {
    if (!toConfirm) return;
    shown.current.add(toConfirm.id);
    setSheet({ type: "agent", agentId: toConfirm.agent });
  }, [toConfirm]);

  if (status !== "ready") {
    const first = (
      <div className="no-scrollbar relative h-full w-full overflow-y-auto bg-page">
        {status === "no-wallet" ? <CreateWallet /> : status === "unreachable" ? <NotReachable /> : <Connecting />}
      </div>
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
    <div className="relative h-full w-full overflow-clip bg-page">
        <main ref={scrollRef} className="no-scrollbar absolute inset-0 overflow-y-auto pb-36" key={sub ?? tab}>
          <StatusBanner />
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
        {sheet?.type === "run" && <RunSheet pendingId={sheet.pendingId} onClose={close} />}
        {sheet?.type === "agent" && <AgentSheet agentId={sheet.agentId} onClose={close} />}
        {sheet?.type === "addressActivity" && <AddressActivitySheet address={sheet.address} title={sheet.title} onClose={close} />}
        {sheet?.type === "agentSwitch" && <AgentSwitchSheet agentId={sheet.agentId} onClose={close} />}
        {sheet?.type === "saveLimits" && <SaveLimitsSheet action={sheet.action} how={sheet.how} onClose={close} />}
        {sheet?.type === "createCard" && <CreateCardSheet kind={sheet.kind} onClose={close} />}
        {sheet?.type === "cards" && (
          <CardsSheet
            holder={sheet.holder}
            onClose={close}
            onAdd={() => setSheet(sheet.holder === "methods" ? { type: "createCard" } : { type: "addAgent" })}
            onPick={sheet.holder === "agents" ? (agentId) => setSheet({ type: "agent", agentId }) : undefined}
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
