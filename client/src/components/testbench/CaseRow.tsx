import type { CaseRowModel } from "./rollup";
import StatusIndicator from "./StatusIndicator";
import CaseStateLabel from "./CaseStateLabel";
import { STALE_CASE_LABEL, STALE_CASE_TITLE } from "./staleCase";

// One case row in the virtualised list (#466). Renders only the human-readable
// case fields (id + title) plus the StatusIndicator: the raw JSON plan/result is
// never serialised into the DOM (acceptance criterion). The case detail + marks
// surface is a separate slice (#16) and out of scope here. A case whose result
// was judged against an earlier version of the case carries a Stale label
// (#1696).
export default function CaseRow({ model }: { model: CaseRowModel }) {
  const { case: c, status } = model;
  return (
    <div className="flex items-center gap-3 px-4 py-2 min-w-0">
      <span className="font-mono text-11 text-text-secondary shrink-0">{c.id}</span>
      <span className="text-13 text-text-primary truncate min-w-0 flex-1">{c.title}</span>
      {model.stale === true && (
        <CaseStateLabel tone="attention" title={STALE_CASE_TITLE}>
          {STALE_CASE_LABEL}
        </CaseStateLabel>
      )}
      <StatusIndicator status={status} />
    </div>
  );
}
