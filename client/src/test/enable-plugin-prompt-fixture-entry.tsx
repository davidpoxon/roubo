// Dev-only entry point used by `e2e/enable-plugin-prompt.spec.ts` (TC-152).
// Mounts the real `EnablePluginPromptModal` behind a trigger button so the
// Playwright spec can exercise focus trap, Esc-restores-focus, and
// Enter-confirms against React Aria's actual behaviour in a browser without a
// running backend. The spec uses `page.route()` to stub the enable RPC.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EnablePluginPromptModal from "../components/EnablePluginPromptModal";
import ToastProvider from "../components/ToastProvider";
import "../globals.css";

type Phase = "idle" | "opened" | "cancelled" | "enabled";

export function Fixture() {
  const [phase, setPhase] = useState<Phase>("idle");

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 14, marginBottom: 16 }}>EnablePluginPromptModal fixture</h1>
      <button
        type="button"
        data-testid="open-enable-prompt"
        onClick={() => setPhase("opened")}
        style={{
          padding: "8px 12px",
          fontSize: 13,
          border: "1px solid #d6d3d1",
          borderRadius: 6,
          background: "#fafaf9",
          cursor: "pointer",
        }}
      >
        Open prompt
      </button>
      <pre data-testid="phase-debug" style={{ marginTop: 24, fontSize: 12 }}>
        {phase}
      </pre>

      {phase === "opened" && (
        <EnablePluginPromptModal
          projectId="proj-1"
          pluginId="github-com"
          pluginName="GitHub.com"
          onCancel={() => setPhase("cancelled")}
          onEnabled={() => setPhase("enabled")}
        />
      )}
    </main>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("enable-plugin-prompt fixture: #root not found");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </QueryClientProvider>,
);
