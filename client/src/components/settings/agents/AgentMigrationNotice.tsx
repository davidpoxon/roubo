import { useState } from "react";
import { Button } from "react-aria-components";
import { X } from "lucide-react";
import { useSettings } from "../../../hooks/useSettings";

export const STORAGE_KEY = "roubo-agent-migration-notice-dismissed";

const STRINGS = {
  label: "Agent settings notice",
  heading: "Agents are now plugins.",
  body:
    "Roubo no longer starts an AI coding agent of its own: every launch goes through an agent plugin. " +
    "Your previous agent preferences were not carried over, so install the agent you use from the Marketplace " +
    "and set its defaults here.",
  dismiss: "Dismiss agent settings notice",
};

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Storage unavailable (private browsing, full quota): treat as dismissed so
    // a notice that can never be dismissed for good is never shown at all.
    return true;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // Silently degrade when storage is unavailable.
  }
}

/**
 * The one-time upgrade notice on Settings > AI Agents (AP-FR-021, issue #521).
 *
 * Shown only when the server reports that `settings.json` still carries the
 * retired built-in agent preferences, so a fresh install never sees it
 * (AP-TC-110). Dismissal is remembered in localStorage, which is what makes it
 * exactly once across restarts of a desktop app (AP-TC-109). Nothing is
 * migrated: the copy says so outright rather than implying settings moved
 * (AP-TC-111).
 */
export default function AgentMigrationNotice() {
  const { settings } = useSettings();
  // Read storage synchronously on first render so a dismissed notice never flashes.
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed || settings?.legacyAgentSettingsPresent !== true) return null;

  return (
    <div
      role="note"
      aria-label={STRINGS.label}
      data-testid="agent-migration-notice"
      className="flex items-start gap-3 bg-stone-50 dark:bg-stone-900/50 border-l-2 border-amber-500 rounded-r px-4 py-3"
    >
      <div className="flex-1 text-sm text-stone-700 dark:text-stone-300">
        <span className="font-medium">{STRINGS.heading}</span> {STRINGS.body}
      </div>
      <Button
        aria-label={STRINGS.dismiss}
        onPress={() => {
          writeDismissed();
          setDismissed(true);
        }}
        className="shrink-0 p-1 -m-1 rounded text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200/50 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <X size={14} />
      </Button>
    </div>
  );
}
