// A short uppercase label beside a case's id: a lifecycle state in the archived
// section ("Retired", "Superseded", #1161) or "Stale" on a live case whose result
// was judged against an earlier version of the case (#1696). The neutral tone is
// the archived look; the attention tone uses the accent roles of the staleness
// banner, so the label and the banner read as one signal.
const TONE = {
  neutral: "text-text-body bg-bg-pressed",
  attention: "text-accent-text bg-accent-muted",
} as const;

export default function CaseStateLabel({
  children,
  tone = "neutral",
  title,
}: {
  children: string;
  tone?: keyof typeof TONE;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`rounded px-1.5 py-0.5 text-11 font-semibold uppercase tracking-label shrink-0 ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
