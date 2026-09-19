export function OverrideBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-11 font-medium px-1.5 py-0.5 rounded bg-accent-muted text-accent-text">
      <span className="sr-only">Project override active. </span>
      <span className="w-1 h-1 rounded-full bg-accent shrink-0" aria-hidden="true" />
      <span>Override</span>
    </span>
  );
}
