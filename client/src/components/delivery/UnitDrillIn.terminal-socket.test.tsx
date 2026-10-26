// @vitest-environment jsdom
// The bench's Terminal tab and a unit's drill-in mounted together (SB-FR-013).
// The Terminal tab is force-mounted on every bench and holds a socket to each
// session, the delivery session included. An active unit's drill-in embeds the
// live delivery session too, over a socket of its own: the server takes several
// viewers per session, so the two sockets stay open side by side, and closing
// the drill-in closes its socket only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import type { DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { renderWithProviders } from "../../test/renderWithProviders";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { FakeSocket } from "../../test/fake-terminal";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDelivery: vi.fn(),
    fetchDeliveryEvents: vi.fn(),
    fetchDeliveryUnitDiff: vi.fn(),
    fetchDeliveryUnitTranscript: vi.fn(),
    fetchTerminals: vi.fn(),
  };
});
vi.mock("../../hooks/useTerminal");
vi.mock("../../hooks/useJigs");
vi.mock("../../hooks/useSettings");
vi.mock("../../hooks/useBenches");
vi.mock("../../hooks/useToast");
vi.mock("../../hooks/useAgentTools");
vi.mock("../../hooks/useProjectAgents");
vi.mock("../../hooks/useProjectDefaultJig");
// The real Terminal and its real connection hook run in both views; only xterm,
// which needs a canvas, and the socket are stand-ins.
vi.mock("@xterm/xterm", () => import("../../test/fake-terminal"));
vi.mock("@xterm/addon-fit", () => import("../../test/fake-terminal"));
vi.mock("@xterm/addon-web-links", () => import("../../test/fake-terminal"));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import * as api from "../../lib/api";
import {
  useCreateTerminal,
  useDestroyTerminal,
  useTerminalSessions,
} from "../../hooks/useTerminal";
import { useInjectJig, useJigs } from "../../hooks/useJigs";
import { useSettings } from "../../hooks/useSettings";
import { useDismissNotification } from "../../hooks/useBenches";
import { useToast } from "../../hooks/useToast";
import { useAgentPresets } from "../../hooks/useAgentTools";
import { useProjectAgents } from "../../hooks/useProjectAgents";
import { useProjectDefaultJig } from "../../hooks/useProjectDefaultJig";
import TerminalTabs from "../TerminalTabs";
import DeliveryTabPanel from "./DeliveryTabPanel";

const bench = {
  id: 3,
  projectId: "demo",
  variant: "specbench",
  status: "active",
  focusedSpecPath: "/repos/demo/.specifications/fixture-spec",
  deliveryBindMode: "launch",
  deliverySessionId: "session-1",
} as unknown as Bench;

// The delivery session is the bench's second terminal, so the Terminal tab
// opens on the first one until something selects it.
const sessions = [
  {
    id: "shell-1",
    benchKey: "demo:3",
    label: "Shell",
    createdAt: "2026-10-16T09:00:00Z",
    command: "zsh",
    status: "live",
  },
  {
    id: "session-1",
    benchKey: "demo:3",
    label: "Delivery",
    createdAt: "2026-10-16T09:01:00Z",
    command: "claude",
    status: "live",
  },
];

function Bench3() {
  return (
    <>
      <DeliveryTabPanel bench={bench} />
      <TerminalTabs projectId="demo" benchId={3} projectName="Demo" hasAssignedIssue={false} />
    </>
  );
}

let record: DeliveryRecord;

beforeEach(() => {
  localStorage.clear();
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "EventSource",
    vi.fn(function FakeEventSource() {
      return { onmessage: null, onerror: null, onopen: null, readyState: 1, close: vi.fn() };
    }),
  );
  record = {
    ...fourUnitRecord(),
    units: fourUnitRecord().units.map((unit) =>
      unit.id === "B" ? { ...unit, status: "running" } : unit,
    ),
  };
  const log = [unitEvent(8, "B", "unit.changed", { status: "running" }, "2026-10-16T09:40:00Z")];
  vi.mocked(api.fetchDelivery).mockImplementation(async () =>
    foldDelivery({ record, events: [...log] }),
  );
  vi.mocked(api.fetchDeliveryEvents).mockImplementation(async (_p, _b, query = {}) => ({
    events: log.filter((event) => query.unit === undefined || event.unit_id === query.unit),
    acceptedSeq: 8,
  }));
  vi.mocked(api.fetchDeliveryUnitDiff).mockImplementation(async (_p, _b, unit) => ({
    unit,
    base: null,
    head: null,
    diff: "",
    truncated: false,
  }));
  vi.mocked(api.fetchTerminals).mockResolvedValue([]);
  vi.mocked(useTerminalSessions).mockReturnValue({
    data: sessions,
  } as unknown as ReturnType<typeof useTerminalSessions>);
  vi.mocked(useCreateTerminal).mockReturnValue({
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useCreateTerminal>);
  vi.mocked(useDestroyTerminal).mockReturnValue({
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useDestroyTerminal>);
  vi.mocked(useJigs).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useJigs>);
  vi.mocked(useInjectJig).mockReturnValue({
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useInjectJig>);
  vi.mocked(useSettings).mockReturnValue({
    settings: { theme: "dark", jigs: { autoInject: false, autoExecute: false } },
    isLoading: false,
    updateSettings: vi.fn(),
  } as unknown as ReturnType<typeof useSettings>);
  vi.mocked(useDismissNotification).mockReturnValue({
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useDismissNotification>);
  vi.mocked(useToast).mockReturnValue({ addToast: vi.fn(), removeToast: vi.fn() });
  vi.mocked(useAgentPresets).mockReturnValue({
    data: { presets: [] },
  } as unknown as ReturnType<typeof useAgentPresets>);
  vi.mocked(useProjectAgents).mockReturnValue({
    data: { agents: [], orphanedOverrides: [] },
  } as unknown as ReturnType<typeof useProjectAgents>);
  vi.mocked(useProjectDefaultJig).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useProjectDefaultJig>);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Unit drill-in beside the Terminal tab", () => {
  it("SB-TC-031 embeds an active unit's live terminal beside the Terminal tab's own socket to the session", async () => {
    renderWithProviders(<Bench3 />);
    await act(async () => {});
    // The Terminal tab holds one socket to each session.
    expect(FakeSocket.to("session-1")).toHaveLength(1);
    expect(FakeSocket.to("shell-1")).toHaveLength(1);
    const [tabSocket] = FakeSocket.to("session-1");

    // Open B, which is active, from the map: its drill-in attaches a second
    // viewer to the delivery session, and the tab's socket stays open.
    await userEvent.click(await screen.findByTestId("unit-node-B"));
    const drillIn = screen.getByRole("region", { name: "Unit B" });
    const terminal = within(drillIn).getByRole("region", { name: "Terminal of unit B" });
    await act(async () => {});
    const sockets = FakeSocket.to("session-1");
    expect(sockets).toHaveLength(2);
    const [, drillInSocket] = sockets;
    expect(tabSocket.closed).toBe(false);
    expect(drillInSocket.closed).toBe(false);

    // Each viewer gets the session's frames, and the drill-in's shows them.
    act(() => {
      for (const socket of sockets) {
        socket.receive({ type: "replay", lines: ["$ claude\r\n"] });
        socket.receive({ type: "output", data: "working on B\r\n" });
      }
    });
    expect(within(terminal).getByTestId("xterm-screen")).toHaveTextContent("$ claude working on B");

    // Input typed in the drill-in goes out on the drill-in's socket.
    fireEvent.input(within(terminal).getByRole("textbox", { name: "Terminal input" }), {
      target: { value: "continue" },
    });
    expect(drillInSocket.sent).toContainEqual({ type: "input", data: "continue" });
    expect(tabSocket.sent).not.toContainEqual({ type: "input", data: "continue" });

    // Closing the drill-in closes its socket only; the tab's stays open and
    // nothing reconnects.
    await userEvent.click(within(drillIn).getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(drillInSocket.closed).toBe(true);
    expect(tabSocket.closed).toBe(false);
    expect(FakeSocket.to("session-1")).toHaveLength(2);
  });
});
