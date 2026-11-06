import { useEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { DeliveryControl } from "@roubo/shared/delivery-control-contract";
import type { DeliveryDecision } from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot, DeliveryThreadMessage } from "@roubo/shared/delivery-reducer";
import {
  selectDecisionThread,
  selectReviewStack,
  selectReviewedAgentDecisions,
} from "@roubo/shared/delivery-selectors";
import Button from "../ui/Button";
import { focusRing } from "../ui/focus-ring";

// The agent decisions on the decision pile (SB-FR-033, SB-FR-034, SB-NFR-009),
// the Review card of DESIGN.md. Each decision the session made on its own in
// auto mode waits here for the operator's review, oldest first. The oldest card
// is the live top card under the 2px accent rule: its badge, a mono origin line
// naming where it was decided and the units it affects, the question, the
// choice, the rationale and its Discuss action, which shows the decision's
// thread read-only. A lower card shows only its title bar,
// and raises on click or Enter, so a pile of a hundred cards renders one body.
// A reviewed card leaves with `drop-away` and the next oldest rises.
//
// The badge reads `to review` while a review is open, `decided` during a run,
// and `queued` while an operator's review control on the decision waits in the
// outbox; this card issues none itself. Every text the
// session wrote (the question, the choice, the rationale, a reply, a summary)
// renders as a React text node: never as markup, and never as a link.

// How long a leaving card stays for its drop-away: motion.duration.fast.
export const REVIEW_DROP_AWAY_MS = 150;

const OUTSTANDING_STATUSES: ReadonlySet<string> = new Set(["pending", "queued", "delivered"]);

// The operator's outstanding review control on a decision, if any: an accept,
// or an overturn, which is also a review outcome. The card only reads it.
function queuedAction(
  controls: readonly DeliveryControl[],
  decisionId: string,
): "accept" | "overturn" | undefined {
  let action: "accept" | "overturn" | undefined;
  for (const control of controls) {
    if (control.target_id !== decisionId || !OUTSTANDING_STATUSES.has(control.status)) continue;
    if (control.kind === "review_accept") action = "accept";
    else if (control.kind === "overturn") action = "overturn";
  }
  return action;
}

type ReviewWord = "to review" | "decided" | "queued";

function reviewWord(reviewOpen: boolean, queued: string | undefined): ReviewWord {
  if (queued !== undefined) return "queued";
  return reviewOpen ? "to review" : "decided";
}

// Where the agent decided and what the decision affects.
function originText(decision: DeliveryDecision): string {
  const where = decision.unit_id === undefined ? "the delivery" : decision.unit_id;
  const affected = decision.affected_units ?? [];
  return `agent decided at ${where} · affects ${affected.length > 0 ? affected.join(", ") : "no unit"}`;
}

function Badge({ decision, word }: { decision: DeliveryDecision; word: ReviewWord }) {
  return (
    <span
      data-testid="review-badge"
      className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
    >
      {decision.id} · {word}
    </span>
  );
}

function ThreadMessage({ message }: { message: DeliveryThreadMessage }) {
  // A read-back of the operator's own message names its control; every other
  // message is the session's reply, on the inset ground.
  const fromOperator = message.controlSeq !== undefined;
  return (
    <li
      data-testid={`review-thread-message-${message.seq}`}
      className={`space-y-1 rounded-card p-2 ${fromOperator ? "" : "bg-bg-base"}`}
    >
      <p className="flex gap-2 font-mono text-11 text-text-secondary">
        <span>{fromOperator ? "you" : message.author}</span>
        <span>{message.ts}</span>
      </p>
      <p className="whitespace-pre-wrap break-words text-13 text-text-body">{message.text}</p>
    </li>
  );
}

function TopCard({
  decision,
  word,
  queued,
  thread,
}: {
  decision: DeliveryDecision;
  word: ReviewWord;
  queued: "accept" | "overturn" | undefined;
  thread: readonly DeliveryThreadMessage[];
}) {
  const [discussing, setDiscussing] = useState(false);
  const threadId = `review-thread-${decision.id}`;
  return (
    <article
      data-testid={`review-card-${decision.id}`}
      data-position="top"
      aria-label={`Agent decision ${decision.id}`}
      className="animate-rise-in space-y-2 rounded-card border border-border border-t-2 border-t-accent bg-bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge decision={decision} word={word} />
        <span data-testid="review-origin" className="font-mono text-12 text-text-secondary">
          {originText(decision)}
        </span>
      </div>
      <p className="text-13 text-text-primary">{decision.question}</p>
      <p data-testid="review-choice" className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-11 font-medium text-text-secondary">chose</span>
        <span className="text-13 font-medium text-text-primary">{decision.chosen}</span>
      </p>
      {decision.rationale !== undefined && (
        <p
          data-testid="review-rationale"
          className="whitespace-pre-wrap break-words text-13 text-text-body"
        >
          {decision.rationale}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-expanded={discussing}
          aria-controls={discussing ? threadId : undefined}
          onPress={() => setDiscussing((open) => !open)}
        >
          Discuss
        </Button>
      </div>
      {queued !== undefined && (
        <p>
          <span
            data-testid="review-queued"
            className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
          >
            {queued} queued · next boundary
          </span>
        </p>
      )}
      {discussing && (
        <div id={threadId} data-testid={threadId} className="space-y-2 border-t border-border pt-2">
          {thread.length === 0 ? (
            <p className="text-12 text-text-secondary">No messages on this decision yet</p>
          ) : (
            <ol aria-label={`Thread of ${decision.id}`} className="space-y-2">
              {thread.map((message) => (
                <ThreadMessage key={message.seq} message={message} />
              ))}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}

export default function ReviewPile({ snapshot }: { snapshot: DeliverySnapshot }) {
  const cards = selectReviewStack(snapshot).flatMap((card) =>
    card.kind === "decision" ? [card.decision] : [],
  );
  const reviewed = selectReviewedAgentDecisions(snapshot);
  const reviewOpen = snapshot.review.status === "open";
  const [raisedId, setRaisedId] = useState<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const [leaving, setLeaving] = useState<DeliveryDecision[]>([]);
  const [seen, setSeen] = useState({ cards, byId: snapshot.decisionsById });

  // A card that left the pile (its review landed) stays for its drop-away.
  // This adjusts state while rendering, as React advises for state derived
  // from a prop change.
  if (seen.byId !== snapshot.decisionsById) {
    const stayed = new Set(cards.map((decision) => decision.id));
    const gone = seen.cards.filter((decision) => !stayed.has(decision.id));
    setSeen({ cards, byId: snapshot.decisionsById });
    if (gone.length > 0) {
      setLeaving((current) => [...current, ...gone]);
      setAnnouncement(gone.map((decision) => `${decision.id} reviewed.`).join(" "));
    }
  }

  useEffect(() => {
    if (leaving.length === 0) return undefined;
    const timer = setTimeout(() => setLeaving([]), REVIEW_DROP_AWAY_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (cards.length === 0 && reviewed.length === 0 && leaving.length === 0) return null;

  const top = cards.find((decision) => decision.id === raisedId) ?? cards[0];
  const lower = cards.filter((decision) => decision !== top);

  return (
    <section
      data-testid="delivery-review-pile"
      aria-label="Agent decisions to review"
      className="space-y-2"
    >
      <div role="status" aria-live="polite" className="sr-only" data-testid="review-announcer">
        {announcement}
      </div>
      {leaving.map((decision) => (
        <div
          key={`leaving-${decision.id}`}
          data-testid={`review-leaving-${decision.id}`}
          aria-hidden="true"
          className="animate-drop-away rounded-card border border-border border-t-2 border-t-accent bg-bg-surface p-3"
        >
          <p className="text-13 text-text-primary">{decision.question}</p>
        </div>
      ))}
      {top !== undefined && (
        <ul aria-label="Review pile" className="space-y-2">
          <li key={`top-${top.id}`}>
            <TopCard
              decision={top}
              word={reviewWord(reviewOpen, queuedAction(snapshot.controls, top.id))}
              queued={queuedAction(snapshot.controls, top.id)}
              thread={selectDecisionThread(snapshot, top.id)}
            />
          </li>
          {lower.map((decision) => (
            <li key={decision.id} className="animate-slide-under">
              <AriaButton
                data-testid={`review-card-${decision.id}`}
                data-position="lower"
                onPress={() => setRaisedId(decision.id)}
                className={`flex w-full flex-wrap items-center gap-2 rounded-card border border-border bg-bg-surface px-3 py-2 text-left transition-colors data-[hovered]:bg-bg-hover data-[pressed]:bg-bg-pressed ${focusRing}`}
              >
                <span className="sr-only">Raise this review card </span>
                <Badge
                  decision={decision}
                  word={reviewWord(reviewOpen, queuedAction(snapshot.controls, decision.id))}
                />
                <span className="font-mono text-12 text-text-secondary">
                  {originText(decision)}
                </span>
              </AriaButton>
            </li>
          ))}
        </ul>
      )}
      {reviewed.length > 0 && (
        <ul aria-label="Reviewed agent decisions" className="space-y-1">
          {reviewed.map((decision) => (
            <li
              key={decision.id}
              data-testid={`review-reviewed-${decision.id}`}
              className="space-y-1 rounded-card border border-border bg-bg-surface px-3 py-2"
            >
              <p className="font-mono text-12 text-text-secondary">
                {decision.id} · {decision.review?.status} · chose {decision.chosen}
              </p>
              {decision.review?.summary !== undefined && (
                <p
                  data-testid={`review-summary-${decision.id}`}
                  className="whitespace-pre-wrap break-words text-13 text-text-body"
                >
                  {decision.review.summary}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
