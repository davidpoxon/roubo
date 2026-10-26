import { useState } from "react";
import type { DeliveryCaseProgress, DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { selectMetCases, selectProgress } from "@roubo/shared/delivery-selectors";
import type { Verification } from "@roubo/shared/testbench-contracts";
import Button from "../ui/Button";

// Progress on the Delivery tab (SB-FR-011, SB-US-003): counted in test cases
// met and requirements covered, never in units done. Each met case opens its
// verify record and links the pull request of the unit that met it.

interface DeliveryStatProps {
  testId: string;
  eyebrow: string;
  value: number;
  note: string;
  // The meter's fill, from 0 to 1. Absent, the stat has no meter.
  fill?: number;
}

// A Delivery stat (DESIGN.md): a mono eyebrow, a value, a note and an optional
// meter whose fill is the only accent on the strip. The space between the value
// and the note keeps the figure readable as one phrase ("3 of 10 cases met").
function DeliveryStat({ testId, eyebrow, value, note, fill }: DeliveryStatProps) {
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-1 bg-bg-surface p-3">
      <span className="font-mono text-11 font-medium text-text-secondary">{eyebrow}</span>
      <span className="font-mono text-16 font-semibold text-text-primary">{value}</span>{" "}
      <span className="text-11 text-text-secondary">{note}</span>
      {fill !== undefined && (
        <span aria-hidden="true" className="block h-1 w-full rounded-full bg-bg-hover">
          <span
            className="block h-1 rounded-full bg-accent"
            style={{ width: `${Math.round(fill * 100)}%` }}
          />
        </span>
      )}
    </div>
  );
}

function share(met: number, total: number): number {
  return total === 0 ? 0 : met / total;
}

export function DeliveryProgressStats({ snapshot }: { snapshot: DeliverySnapshot }) {
  const { cases, requirements } = selectProgress(snapshot);
  return (
    <div data-testid="delivery-progress" className="grid grid-cols-2 gap-px">
      <DeliveryStat
        testId="delivery-stat-cases"
        eyebrow="Cases"
        value={cases.met}
        note={`of ${cases.total} cases met`}
        fill={share(cases.met, cases.total)}
      />
      <DeliveryStat
        testId="delivery-stat-requirements"
        eyebrow="Requirements"
        value={requirements.met}
        note={`of ${requirements.total} requirements covered`}
        fill={share(requirements.met, requirements.total)}
      />
    </div>
  );
}

// Only an http(s) URL becomes a link: `pr_url` is a string the session writes.
function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function verifiedLine(verification: Verification): string {
  const { tier, confidence, author, timestamp } = verification;
  return `tier ${tier}, ${confidence} confidence, by ${author.name} at ${timestamp}`;
}

function VerifyRecord({ entry }: { entry: DeliveryCaseProgress }) {
  const { result } = entry;
  return (
    <div
      data-testid={`delivery-verify-record-${entry.id}`}
      className="space-y-1 rounded-control border border-border bg-bg-surface p-3 text-13"
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

export function DeliveryMetCases({ snapshot }: { snapshot: DeliverySnapshot }) {
  const met = selectMetCases(snapshot);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = met.find((entry) => entry.id === openId);
  return (
    <section data-testid="delivery-met-cases" aria-label="Cases met" className="space-y-2">
      {met.length === 0 ? (
        <p className="text-13 text-text-secondary">No case is met yet</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {met.map((entry) => (
            <Button
              key={entry.id}
              aria-expanded={entry.id === openId}
              onPress={() => setOpenId(entry.id === openId ? null : entry.id)}
            >
              {entry.id}
            </Button>
          ))}
        </div>
      )}
      {open && <VerifyRecord entry={open} />}
    </section>
  );
}
