import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "react-aria-components";
import { X } from "lucide-react";

export const STORAGE_KEY = "roubo-first-n-banner";

type Entry = { count: number; dismissed: boolean };
type Store = Record<string, Entry>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeEntry(routeKey: string, patch: Partial<Entry>): void {
  try {
    const store = readStore();
    const existing: Entry = store[routeKey] ?? { count: 0, dismissed: false };
    const next: Entry = { ...existing, ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...store, [routeKey]: next }));
  } catch {
    // Silently degrade when storage is unavailable (private browsing, full quota).
  }
}

export default function FirstNSessionsBanner({
  routeKey,
  sessionCount,
  label = "Information",
  children,
}: {
  routeKey: string;
  sessionCount: number;
  label?: string;
  children: ReactNode;
}) {
  // Read storage synchronously on first render so retired banners never flash.
  const [entry] = useState<Entry>(() => {
    const stored = readStore()[routeKey];
    return { count: stored?.count ?? 0, dismissed: stored?.dismissed ?? false };
  });
  const [manuallyDismissed, setManuallyDismissed] = useState(false);

  const shouldRender =
    sessionCount > 0 && !entry.dismissed && !manuallyDismissed && entry.count < sessionCount;

  // Ref guard ensures a single increment write per mount even in React StrictMode.
  const didIncrementRef = useRef(false);
  useEffect(() => {
    if (didIncrementRef.current) return;
    didIncrementRef.current = true;
    if (!entry.dismissed && entry.count < sessionCount) {
      writeEntry(routeKey, { count: entry.count + 1 });
    }
  }, [routeKey, entry.dismissed, entry.count, sessionCount]);

  if (!shouldRender) return null;

  return (
    <div
      role="note"
      aria-label={label}
      className="flex items-start gap-3 bg-stone-50 dark:bg-stone-900/50 border-l-2 border-amber-500 rounded-r px-4 py-3 mb-6"
    >
      <div className="flex-1 text-sm text-stone-700 dark:text-stone-300">{children}</div>
      <Button
        aria-label="Dismiss banner"
        onPress={() => {
          writeEntry(routeKey, { dismissed: true });
          setManuallyDismissed(true);
        }}
        className="shrink-0 p-1 -m-1 rounded text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200/50 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <X size={14} />
      </Button>
    </div>
  );
}
