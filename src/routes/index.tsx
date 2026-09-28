import { createFileRoute } from "@tanstack/react-router";
import { KupletApp } from "@/components/kuplet-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <KupletApp />;
}
