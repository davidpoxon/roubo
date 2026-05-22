// Dev-only entry point used by `e2e/source-picker.spec.ts`.
// Vite builds only `index.html` by default, so this fixture does not ship to
// production. It exists so Playwright can drive the SourcePicker in isolation
// without needing a running backend or a fixture integration plugin.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import SourcePicker from "../components/SourcePicker";
import type { SourceCandidatesResponse, SourceSelection } from "@roubo/shared";
import "../index.css";

const MULTI_LIST: SourceCandidatesResponse = {
  shape: "multi-list",
  items: [
    { externalId: "org/api", label: "org/api", sublabel: "Backend service", icon: "repo" },
    { externalId: "org/web", label: "org/web", sublabel: "Frontend", icon: "repo" },
    { externalId: "proj-42", label: "Roadmap", sublabel: "Project board", icon: "project" },
  ],
};

const CATEGORIZED: SourceCandidatesResponse = {
  shape: "categorized-multi-list",
  categories: [
    {
      id: "boards",
      label: "Boards",
      items: [
        { externalId: "b1", label: "Engineering", icon: "board" },
        { externalId: "b2", label: "Design", icon: "board" },
      ],
    },
    {
      id: "epics",
      label: "Epics",
      items: [{ externalId: "e1", label: "Q1 launch", icon: "epic" }],
    },
    {
      id: "filters",
      label: "Filters",
      items: [{ externalId: "f1", label: "Open bugs", icon: "filter" }],
    },
  ],
};

export function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const shape = params.get("shape") === "categorized" ? "categorized" : "multi";
  const response = shape === "categorized" ? CATEGORIZED : MULTI_LIST;
  const [value, setValue] = useState<SourceSelection>({});

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 14, marginBottom: 16 }}>SourcePicker fixture</h1>
      <SourcePicker response={response} value={value} onChange={setValue} />
      <pre data-testid="value-debug" style={{ marginTop: 24, fontSize: 12 }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </main>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("source-picker fixture: #root not found");
createRoot(rootEl).render(<Fixture />);
