export function OverrideBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
      <span className="sr-only">Project override active. </span>
      <span className="w-1 h-1 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
      <span>Override</span>
    </span>
  );
}
