import { useState, useCallback } from "react";

const STORAGE_KEY = "roubo-bench-view-state";

export type BenchTabId = "components" | "terminal" | "inspection" | "info";

type BenchViewEntry = { activeTab?: BenchTabId; activeTerminalSessionId?: string };
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

  return {
    activeTab: entry.activeTab,
    setActiveTab,
    activeTerminalSessionId: entry.activeTerminalSessionId,
    setActiveTerminalSessionId,
  };
}
