import { useState } from "react";
import { Button } from "react-aria-components";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { useMigrationStatus } from "../hooks/useMigrationStatus";

// One-time migration banner from WU-024 / issue #42. Renders at most once per
// machine per migration `at` timestamp — once dismissed, the localStorage marker
// keeps it dismissed across reloads. Success and rolled-back variants per
// .specifications/integration-plugins/prototype/mockups.md §13.

export const STORAGE_KEY_PREFIX = "roubo.migration.dismissed:";

const LEARN_MORE_URL =
  "https://github.com/davidpoxon/roubo/blob/main/.specifications/integration-plugins/prd.md";

function readDismissed(at: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_KEY_PREFIX}${at}`) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(at: string): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${at}`, "1");
  } catch {
    // Silently degrade when storage is unavailable.
  }
}

export default function MigrationBanner() {
  const { data } = useMigrationStatus();
  const migration = data?.migration ?? null;
  const [manuallyDismissed, setManuallyDismissed] = useState(false);

  if (!migration) return null;
  // Check localStorage on every render: the migration record may arrive AFTER
  // first paint, so a useState-lazy-init wouldn't see a pre-existing dismissal.
  if (manuallyDismissed || readDismissed(migration.at)) return null;

  const onDismiss = () => {
    writeDismissed(migration.at);
    setManuallyDismissed(true);
  };

  if (migration.status === "success") {
    return (
      <div
        role="status"
        aria-label="Migration succeeded"
        className="flex items-start gap-3 bg-stone-100 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800 px-4 py-2 text-sm text-stone-800 dark:text-stone-200"
      >
        <div className="flex-1">
          Roubo now manages GitHub integration through a plugin. Your projects have been migrated;
          you don&apos;t need to take any action.{" "}
          <a
            href={LEARN_MORE_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-stone-400 hover:decoration-amber-500 transition-colors"
          >
            Learn more
          </a>
        </div>
        <Button
          aria-label="Dismiss migration banner"
          onPress={onDismiss}
          className="shrink-0 p-1 -m-1 rounded text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-100 hover:bg-stone-200/60 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <X size={14} />
        </Button>
      </div>
    );
  }

  // rolled-back variant
  return (
    <div
      role="alert"
      aria-label="Migration rolled back"
      className="flex items-start gap-3 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 px-4 py-2 text-sm text-red-900 dark:text-red-200"
    >
      <div className="flex-1">
        Roubo could not migrate your GitHub configuration automatically. Your existing setup is
        unchanged.{" "}
        <Link
          to="/settings#plugins"
          className="underline decoration-red-400 hover:decoration-red-700 transition-colors"
        >
          Open Plugins page
        </Link>
      </div>
      <Button
        aria-label="Dismiss migration banner"
        onPress={onDismiss}
        className="shrink-0 p-1 -m-1 rounded text-red-500 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 hover:bg-red-100/60 dark:hover:bg-red-900/40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <X size={14} />
      </Button>
    </div>
  );
}
