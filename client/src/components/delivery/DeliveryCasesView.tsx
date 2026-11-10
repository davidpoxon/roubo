import { useRef, useState, type KeyboardEvent } from "react";
import type { DeliveryCaseProgress, DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectProgress } from "@roubo/shared/delivery-selectors";
import type { Case, Verification } from "@roubo/shared/testbench-contracts";
import { useTestbenchPlan } from "../../hooks/useTestbenchPlan";
import StatusIndicator from "../ui/StatusIndicator";
import { focusRing } from "../ui/focus-ring";
import { DeliveryPanel } from "./DeliveryPanel";
import { DeliveryProgressStats } from "./DeliveryProgress";
import { isWebUrl } from "./web-url";

// The cases view of the Delivery tab (#1655, SB-FR-011): the progress in cases
// met and requirements covered, a list of every gating case in plan order,
// and the detail of the selected case beside the list on a wide view and under
// it on a narrow one. The detail names the case and what it checks (its title,
// level, area and steps with what each step expects, read from the bench's
// test plan) and the requirements and stories it links, then its verify
// record and the pull request of the unit that met it. While the plan is read,
// or when it cannot be read, the detail shows the case id and its verify
// record alone, and says so.
//
// The list is a single Tab stop: the arrow keys, Home and End move the
// selection, and the selection follows the focus.

type Filter = "all" | "met";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "met", label: "Met" },
];

const EYEBROW = "font-mono text-11 font-medium uppercase tracking-label text-text-secondary";

function verifiedLine(verification: Verification): string {
  const { tier, confidence, author, timestamp } = verification;
  return `tier ${tier}, ${confidence} confidence, by ${author.name} at ${timestamp}`;
}

export default function DeliveryCasesView({
  projectId,
  benchId,
  snapshot,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
}) {
  const { caseList } = selectProgress(snapshot);
  const plan = useTestbenchPlan(projectId, benchId);
  const planCases = new Map<string, Case>(
    (plan.data?.plan.cases ?? []).map((planCase) => [planCase.id, planCase]),
  );
  const [filter, setFilter] = useState<Filter>("all");
  const shown = filter === "met" ? caseList.filter((entry) => entry.met) : caseList;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The first met case is selected until the operator picks one, and a pick
  // the filter hides gives way to the first case shown.
  const selected =
    shown.find((entry) => entry.id === selectedId) ?? shown.find((entry) => entry.met) ?? shown[0];
  const list = useRef<HTMLUListElement>(null);

  const select = (index: number) => {
    const entry = shown[index];
    if (entry === undefined) return;
    setSelectedId(entry.id);
    list.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = selected === undefined ? -1 : shown.indexOf(selected);
    const next =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? shown.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    select(Math.min(Math.max(next, 0), shown.length - 1));
  };

  return (
    <div data-testid="delivery-cases" className="space-y-4">
      <DeliveryProgressStats snapshot={snapshot} />
      <div className="@container">
        <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(240px,340px)_minmax(0,1fr)]">
          <DeliveryPanel
            testId="delivery-case-list"
            title="Gating cases"
            meta={
              <div
                role="group"
                aria-label="Cases shown"
                className="inline-flex rounded-control border border-border-strong"
              >
                {FILTERS.map((option) => {
                  const pressed = filter === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => setFilter(option.id)}
                      className={`min-h-6 px-2.5 py-0.5 text-12 font-medium transition-colors ${focusRing} ${
                        pressed
                          ? "bg-accent-muted text-accent-text"
                          : "text-text-body hover:bg-bg-hover active:bg-bg-pressed"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            }
          >
            {shown.length === 0 ? (
              <p className="px-3 py-2 text-13 text-text-secondary">
                {filter === "met" ? "No case is met yet" : "No gate names a case"}
              </p>
            ) : (
              <ul
                ref={list}
                aria-label="Cases"
                onKeyDown={onListKeyDown}
                className="divide-y divide-border"
              >
                {shown.map((entry) => {
                  const current = entry === selected;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        data-testid={`delivery-case-${entry.id}`}
                        aria-current={current ? "true" : undefined}
                        tabIndex={current ? 0 : -1}
                        onClick={() => setSelectedId(entry.id)}
                        onFocus={() => setSelectedId(entry.id)}
                        className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ${focusRing} ${
                          current ? "bg-accent-muted" : "hover:bg-bg-hover active:bg-bg-pressed"
                        }`}
                      >
                        <span className="flex w-full items-center gap-3">
                          <span className="font-mono text-11 font-medium text-text-body">
                            {entry.id}
                          </span>
                          <StatusIndicator
                            className="ml-auto"
                            tone={entry.met ? "active" : "idle"}
                            label={entry.met ? "met" : "not met"}
                          />
                        </span>
                        <span className="w-full truncate text-12 text-text-primary">
                          {planCases.get(entry.id)?.title ?? ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </DeliveryPanel>
          {selected !== undefined && (
            <CaseDetail
              entry={selected}
              planCase={planCases.get(selected.id)}
              planState={plan.isPending ? "pending" : plan.isError ? "error" : "read"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CaseDetail({
  entry,
  planCase,
  planState,
}: {
  entry: DeliveryCaseProgress;
  planCase: Case | undefined;
  planState: "pending" | "error" | "read";
}) {
  return (
    <DeliveryPanel testId="delivery-case-detail" title={`Case ${entry.id}`}>
      <div className="space-y-4 p-3">
        {planCase === undefined ? (
          <p data-testid="delivery-case-text-missing" className="text-13 text-text-secondary">
            {planState === "pending"
              ? "Reading the test plan..."
              : planState === "error"
                ? "The case text is not available: the test plan could not be read."
                : "The test plan has no case with this id."}
          </p>
        ) : (
          <CaseText planCase={planCase} />
        )}
        <VerifyRecord entry={entry} />
      </div>
    </DeliveryPanel>
  );
}

function CaseText({ planCase }: { planCase: Case }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-16 font-semibold text-text-primary">{planCase.title}</p>
        <p className="font-mono text-11 text-text-secondary">
          level {planCase.level} · {planCase.area} · {planCase.type}
        </p>
      </div>
      {planCase.preconditions !== undefined && planCase.preconditions.length > 0 && (
        <div className="space-y-1">
          <p className={EYEBROW}>Preconditions</p>
          <ul className="list-disc space-y-0.5 pl-5 text-13 text-text-body">
            {planCase.preconditions.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1">
        <p className={EYEBROW}>Steps</p>
        <ol data-testid="delivery-case-steps" className="list-decimal space-y-2 pl-5 text-13">
          {planCase.steps.map((step) => (
            <li key={step.id} className="text-text-body">
              {step.instruction}
              {step.observations.length > 0 && (
                <ul className="mt-0.5 space-y-0.5 text-12 text-text-secondary">
                  {step.observations.map((observation) => (
                    <li key={observation.id}>Expects: {observation.expected}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-13">
        <dt className="text-text-secondary">Requirements</dt>
        <dd data-testid="delivery-case-requirements" className="font-mono text-12 text-text-body">
          {planCase.linked_requirement_ids.join(", ")}
        </dd>
        <dt className="text-text-secondary">Stories</dt>
        <dd className="font-mono text-12 text-text-body">
          {planCase.linked_user_story_ids.length === 0
            ? "none"
            : planCase.linked_user_story_ids.join(", ")}
        </dd>
      </dl>
    </div>
  );
}

function VerifyRecord({ entry }: { entry: DeliveryCaseProgress }) {
  const { result } = entry;
  return (
    <div
      data-testid={`delivery-verify-record-${entry.id}`}
      className="space-y-1 rounded-control border border-border bg-bg-base p-3 text-13"
    >
      <p className="font-medium text-text-primary">Verify record of {entry.id}</p>
      {result === null ? (
        <p className="text-text-secondary">No result is recorded for this case.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-text-secondary">Status</dt>
          <dd className="text-text-body">
            {result.statusOverride?.status ?? result.derivedStatus}
          </dd>
          {result.statusOverride && (
            <>
              <dt className="text-text-secondary">Marked by</dt>
              <dd className="text-text-body">
                {result.statusOverride.author.name} at {result.statusOverride.timestamp}
              </dd>
            </>
          )}
          {result.verification && (
            <>
              <dt className="text-text-secondary">Verified</dt>
              <dd className="text-text-body">{verifiedLine(result.verification)}</dd>
              {result.verification.evidence.length > 0 && (
                <>
                  <dt className="text-text-secondary">Evidence</dt>
                  <dd className="text-text-body">
                    <ul className="space-y-0.5 font-mono text-12">
                      {result.verification.evidence.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </>
          )}
          {result.notes.length > 0 && (
            <>
              <dt className="text-text-secondary">Notes</dt>
              <dd className="text-text-body">
                <ul className="space-y-0.5">
                  {result.notes.map((note) => (
                    <li key={note.id}>{note.text}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      )}
      <PullRequestLink entry={entry} />
    </div>
  );
}

function PullRequestLink({ entry }: { entry: DeliveryCaseProgress }) {
  if (!entry.met) {
    return <p className="text-text-secondary">No unit has met this case yet.</p>;
  }
  if (entry.metBy === null) {
    return <p className="text-text-secondary">No gate names this case, so no unit met it.</p>;
  }
  if (entry.prUrl === null || !isWebUrl(entry.prUrl)) {
    return <p className="text-text-secondary">{entry.metBy} has no pull request yet.</p>;
  }
  return (
    <p>
      <a
        href={entry.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Pull request of {entry.metBy}
      </a>
    </p>
  );
}
