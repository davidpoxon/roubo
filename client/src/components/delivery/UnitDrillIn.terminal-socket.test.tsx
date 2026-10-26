// @vitest-environment jsdom
// The bench's Terminal tab and a unit's drill-in mounted together (SB-FR-013).
// The Terminal tab is force-mounted on every bench and holds a socket to each
// session, the delivery session included; the server keeps one socket per
// session and closes the older one on each connect. So the drill-in must not
// open a second socket to the delivery session: its live terminal opens the
// Terminal tab on that session instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench } from "@roubo/shared";
import type { DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { renderWithProviders } from "../../test/renderWithProviders";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { useBenchViewState } from "../../hooks/useBenchViewState";

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
// The real Terminal and its real connection hook run; only xterm, which needs a
// canvas, is a stand-in.
vi.mock("@xterm/xterm", () => ({
  Terminal: function MockXTerm() {
    return {
      options: {},
      parser: { registerOscHandler: () => ({ dispose: () => undefined }) },
      loadAddon: () => undefined,
      open: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onResize: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
      write: () => undefined,
    };
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: function MockFitAddon() {
    return { fit: () => undefined, proposeDimensions: () => ({ cols: 80, rows: 24 }) };
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: function MockWebLinks() {
    return { dispose: () => undefined };
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import * as api from "../../lib/api";
import { useCreateTerminal, useDestroyTerminal, useTerminalSessions } from "../../hooks/useTerminal";
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

// Every socket the page opens, by the session its URL names.
let sockets: FakeSocket[];
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
}
const socketsTo = (sessionId: string) =>
  sockets.filter((socket) => socket.url.endsWith(`/ws/terminal/${sessionId}`));

// BenchDetail's tab list reads the active tab from the same view state.
function ActiveBenchTab() {
  const { activeTab } = useBenchViewState("demo", 3);
  return <p data-testid="active-bench-tab">{activeTab ?? "none"}</p>;
}

function Bench3() {
  return (
    <>
      <ActiveBenchTab />
      <DeliveryTabPanel bench={bench} />
      <TerminalTabs projectId="demo" benchId={3} projectName="Demo" hasAssignedIssue={false} />
    </>
  );
}

let record: DeliveryRecord;

beforeEach(() => {
  localStorage.clear();
  sockets = [];
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
  it("SB-TC-031 keeps one socket to the delivery session and opens an active unit's live terminal in the Terminal tab", async () => {
    renderWithProviders(<Bench3 />);
    await act(async () => {});
    // The Terminal tab holds one socket to each session.
    expect(socketsTo("session-1")).toHaveLength(1);
    expect(socketsTo("shell-1")).toHaveLength(1);
    const tabSocket = socketsTo("session-1")[0];

    // Open B, which is active, from the map.
    await userEvent.click(await screen.findByTestId("unit-node-B"));
    const drillIn = screen.getByRole("region", { name: "Unit B" });
    const terminal = within(drillIn).getByRole("region", { name: "Terminal of unit B" });
    const open = within(terminal).getByRole("button", { name: "Open the live terminal" });
    await act(async () => {});

    // The drill-in opened no socket of its own, so the Terminal tab's socket
    // stays open: nothing evicts it, and nothing reconnects.
    expect(socketsTo("session-1")).toEqual([tabSocket]);
    expect(tabSocket.closed).toBe(false);
    expect(sockets).toHaveLength(2);

    // The live terminal is the Terminal tab, on the delivery session.
    expect(screen.getByText("Shell").closest("div")?.className).toContain("bg-bg-pressed");
    await userEvent.click(open);
    expect(screen.getByTestId("active-bench-tab")).toHaveTextContent("terminal");
    expect(screen.getByText("Delivery").closest("div")?.className).toContain("bg-bg-pressed");
    expect(screen.getByText("Shell").closest("div")?.className).not.toContain("bg-bg-pressed");
    await act(async () => {});
    expect(socketsTo("session-1")).toEqual([tabSocket]);
    expect(tabSocket.closed).toBe(false);
  });
});
