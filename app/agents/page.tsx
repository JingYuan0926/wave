import type { Metadata } from "next";
import { AgentsView } from "@/components/agents/agents-view";

export const metadata: Metadata = {
  title: "Agents · WAVE",
};

export default function Page() {
  return <AgentsView />;
}
