import type {
  DeliveryCrossCheckDisagreement,
  DeliveryCrossCheckResponse,
} from "@roubo/shared/delivery-bench";

// The delivery cross-check on the Delivery tab's rail (SB-FR-030, SB-US-010):
// one row per disagreement of the bench's last cross-check, in the order the
// server lists them, each naming its class, what it is about and whether it
// blocks; and, when the last refresh could not read GitHub, the source error.
// It shows nothing while the cross-check finds nothing and reads every source.

const SOURCE_NAMES: Record<string, string> = { github: "GitHub" };

// What a disagreement is about: its unit, its stack, or its case.
function subjectOf(disagreement: DeliveryCrossCheckDisagreement): string {
  if (disagreement.caseId !== undefined) {
    return `${disagreement.unitId ?? ""} ${disagreement.caseId}`.trim();
  }
  return disagreement.unitId ?? disagreement.stack ?? "delivery";
}

export default function DeliveryCrossCheck({
  crossCheck,
}: {
  crossCheck: DeliveryCrossCheckResponse;
}) {
  const { disagreements, sourceError } = crossCheck;
  if (disagreements.length === 0 && sourceError === null) return null;
  return (
    <section data-testid="delivery-crosscheck" aria-label="Cross-check" className="space-y-1">
      {sourceError !== null && (
        <p
          role="status"
          data-testid="delivery-crosscheck-source-error"
          data-source={sourceError.source}
          className="py-0.5 font-mono text-11 text-text-secondary"
        >
          {SOURCE_NAMES[sourceError.source] ?? sourceError.source} could not be read:{" "}
          {sourceError.message}
        </p>
      )}
      {disagreements.length > 0 && (
        <ul data-testid="delivery-crosscheck-list" className="space-y-0.5">
          {disagreements.map((disagreement, index) => (
            <li
              key={`${disagreement.class}-${subjectOf(disagreement)}-${String(index)}`}
              data-testid="delivery-crosscheck-row"
              data-class={disagreement.class}
              data-blocking={disagreement.blocking}
              className="flex items-baseline gap-3 py-0.5 text-12"
            >
              <span data-col="class" className="font-mono text-text-primary">
                {disagreement.class}
              </span>
              <span data-col="subject" className="font-mono text-11 text-text-body">
                {subjectOf(disagreement)}
              </span>
              <span data-col="blocking" className="font-mono text-11 text-text-secondary">
                {disagreement.blocking ? "blocking" : "shown only"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
