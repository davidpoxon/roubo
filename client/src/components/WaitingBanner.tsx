/**
 * The pane-level half of the waiting affordance AP-TC-055 S003-O02 expects: the
 * tab shows the amber dot AND the pane says it is waiting. The tab dot is
 * suppressed for the active tab, so without this strip the one session the user
 * is looking at carries no in-app waiting signal at all (#1119).
 *
 * Shaped after `ReconnectBanner`: the same absolutely positioned `role="status"`
 * strip at the top of the pane, with the amber action-needed treatment
 * `NotificationIndicator` uses. Only one strip is ever mounted at a time; the
 * caller decides which.
 */
export default function WaitingBanner() {
  return (
    <div
      className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 bg-stone-100/95 dark:bg-stone-900/95 backdrop-blur-sm border-b border-stone-200 dark:border-stone-800 px-3 py-1.5 transition-opacity duration-200"
      role="status"
    >
      <span className="size-1.5 rounded-full bg-amber-500 animate-status-pulse shrink-0" />
      <span className="text-xs font-mono text-stone-700 dark:text-stone-300">
        Waiting for your input
      </span>
    </div>
  );
}
