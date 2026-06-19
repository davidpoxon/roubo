import { useState } from "react";
import { Button } from "react-aria-components";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { ONLY_TO_DO_NOTICE_MARKER } from "@roubo/shared";
import { useMigrationStatus } from "../hooks/useMigrationStatus";

// One-time only-to-do default-change banner (FR-018, issue #558). Explains that
// the cut list now excludes In Progress by default and points at the status
// filter where it can be changed per project. Shows once per machine for an
// existing install on the first boot after upgrade: the server stamps a real
// timestamp in the `notices` marker map, and once dismissed the localStorage
// marker (keyed on that timestamp) keeps it dismissed across reloads. A fresh
// install seeds the marker as already-satisfied (the "seeded" sentinel), so the
// banner never shows to a user who never saw the old default.

export const STORAGE_KEY_PREFIX = "roubo.notice.dismissed:";

// Server sentinel for a fresh-install marker: present but never surfaced.
const SEEDED_SENTINEL = "seeded";

function readDismissed(at: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_KEY_PREFIX}${ONLY_TO_DO_NOTICE_MARKER}:${at}`) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(at: string): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${ONLY_TO_DO_NOTICE_MARKER}:${at}`, "1");
  } catch {
    // Silently degrade when storage is unavailable.
  }
}

export default function OnlyToDoNoticeBanner() {
  const { data } = useMigrationStatus();
  const at = data?.notices?.[ONLY_TO_DO_NOTICE_MARKER] ?? null;
  const [manuallyDismissed, setManuallyDismissed] = useState(false);

  // No marker yet, or the fresh-install sentinel: never show.
  if (!at || at === SEEDED_SENTINEL) return null;
  // Check localStorage on every render: the marker may arrive AFTER first paint,
  // so a useState-lazy-init wouldn't see a pre-existing dismissal.
  if (manuallyDismissed || readDismissed(at)) return null;

  const onDismiss = () => {
    writeDismissed(at);
    setManuallyDismissed(true);
  };

  return (
    <div
      role="status"
      aria-label="Cut list default changed"
      className="flex items-start gap-3 bg-stone-100 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800 px-4 py-2 text-sm text-stone-800 dark:text-stone-200"
    >
      <div className="flex-1">
        The cut list now hides In Progress items by default, so it shows only work that is ready to
        pick up. You can change which statuses are excluded per project from the{" "}
        <Link
          to="/settings#plugins"
          className="underline decoration-stone-400 hover:decoration-amber-500 transition-colors"
        >
          status filter
        </Link>
        .
      </div>
      <Button
        aria-label="Dismiss cut list notice"
        onPress={onDismiss}
        className="shrink-0 p-1 -m-1 rounded text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-100 hover:bg-stone-200/60 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <X size={14} />
      </Button>
    </div>
  );
}
