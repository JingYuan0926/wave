"use client";

import { useState } from "react";
import { getMockControls, resetMock, setMockControls, type MockControls } from "@/lib/mock/handler";
import { setWallet } from "@/lib/ui/local";
import { Badge, Button } from "./ui";
import { useWallet } from "./wallet-provider";

/** Controls for UI development. Only a NEXT_PUBLIC_WAVE_MOCK=1 run loads this file. */
export default function MockBar() {
  const { refresh } = useWallet();
  const [, setVersion] = useState(0);
  // The mock clears `rootChangeNext` during a scan. The wallet polls re-render this bar.
  const controls = getMockControls();

  const update = (next: Partial<MockControls>) => {
    setMockControls(next);
    setVersion((version) => version + 1);
    void refresh();
  };

  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-lg flex-wrap items-center gap-2 px-4 py-3">
        <Badge tone="warning">Mock data. No chain.</Badge>
        <Button variant="ghost" onClick={() => update({ offline: !controls.offline })}>
          {controls.offline ? "Bring chain online" : "Take chain offline"}
        </Button>
        <Button
          variant="ghost"
          aria-pressed={controls.rootChangeNext}
          onClick={() => update({ rootChangeNext: !controls.rootChangeNext })}
        >
          {controls.rootChangeNext ? "Root change armed" : "Change root on next scan"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            resetMock();
            setWallet(null);
            setVersion((version) => version + 1);
            void refresh();
          }}
        >
          Reset
        </Button>
      </div>
    </footer>
  );
}
