import { useState, useCallback } from "react";

const STORAGE_KEY = "roubo-bench-view-state";

export type BenchTabId = "components" | "terminal" | "inspection" | "info" | "testbench";

type BenchViewEntry = {
  activeTab?: BenchTabId;
  activeTerminalSessionId?: string;
  // TestBench case-list collapse (#524). Persisted per bench so reclaiming
  // horizontal space for the case-detail pane survives navigation and reload.
  testbenchCaseListCollapsed?: boolean;
};
type BenchViewStore = Record<string, BenchViewEntry>;

function readStore(): BenchViewStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BenchViewStore) : {};
  } catch {
    return {};
  }
}

// Merges patch on top of the current stored entry so that concurrent hook instances
// (BenchDetail + TerminalTabs both call this hook) never clobber each other's fields.
function writeEntry(benchKey: string, patch: Partial<BenchViewEntry>): void {
  const store = readStore();
  const next: BenchViewEntry = { ...store[benchKey], ...patch };
  const updated = JSON.stringify({ ...store, [benchKey]: next });
  if (localStorage.getItem(STORAGE_KEY) !== updated) {
    localStorage.setItem(STORAGE_KEY, updated);
  }
}

// Imperatively set a bench's active tab in storage without mounting the hook.
// Used when a bench is created and we want it to open on a specific tab before
// BenchDetail renders (e.g. a freshly created TestBench opening on the "testbench"
// tab, #418). Writing the persisted entry is enough: BenchDetail reads it on mount.
export function setBenchActiveTab(projectId: string, benchId: number, tab: BenchTabId): void {
  writeEntry(`${projectId}:${benchId}`, { activeTab: tab });
}

export function useBenchViewState(projectId: string, benchId: number) {
  const benchKey = `${projectId}:${benchId}`;

  // Version counter is bumped after every write to trigger a re-render. Reading
  // directly from localStorage each render (rather than caching in useState) means
  // the correct entry is returned immediately when benchKey changes across
  // react-router navigations that keep this hook instance alive.
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const entry: BenchViewEntry = readStore()[benchKey] ?? {};

  const setActiveTab = useCallback(
    (tab: BenchTabId) => {
      writeEntry(benchKey, { activeTab: tab });
      bump();
    },
    [benchKey, bump],
  );

  const setActiveTerminalSessionId = useCallback(
    (id: string | null) => {
      writeEntry(benchKey, { activeTerminalSessionId: id ?? undefined });
      bump();
    },
    [benchKey, bump],
  );

  const setTestbenchCaseListCollapsed = useCallback(
    (collapsed: boolean) => {
      writeEntry(benchKey, { testbenchCaseListCollapsed: collapsed });
      bump();
    },
    [benchKey, bump],
  );

  return {
    activeTab: entry.activeTab,
    setActiveTab,
    activeTerminalSessionId: entry.activeTerminalSessionId,
    setActiveTerminalSessionId,
    testbenchCaseListCollapsed: entry.testbenchCaseListCollapsed ?? false,
    setTestbenchCaseListCollapsed,
  };
}
