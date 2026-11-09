import { useEffect, useRef, useState } from "react";
import { Button as AriaButton, Label, TextArea, TextField } from "react-aria-components";
import type { DeliveryControl } from "@roubo/shared/delivery-control-contract";
import type { DeliveryDecision, DeliveryGate } from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot, DeliveryThreadMessage } from "@roubo/shared/delivery-reducer";
import {
  selectDecisionThread,
  selectNextBoundary,
  selectReviewStack,
  selectReviewedAgentDecisions,
  type ReviewCard,
} from "@roubo/shared/delivery-selectors";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { focusRing } from "../ui/focus-ring";
import { FIELD_LABEL_CLASS, INPUT_CLASS } from "../ui/styles";
import {
  useReviewAction,
  useSittingStage,
  useThreadMessage,
  type ReviewActionRequest,
} from "../../hooks/useDelivery";
import { gateUnconfirmedCount, toConfirmText } from "./delivery-map-model";
import ProvisionalMarkCard from "./ProvisionalMark";
import { PILE_LOWER_BAR, PILE_LOWER_ITEM, PILE_TOP_CARD } from "./pile-styles";
import { recordedProvisionalMark } from "./provisional-mark-model";

// The agent decisions on the decision pile (SB-FR-033, SB-FR-034, SB-NFR-009),
// the Review card of DESIGN.md. Each decision the session made on its own in
// auto mode waits here for the operator's review, oldest first. The oldest card
// is the live top card under the 2px accent rule: its badge, a mono origin line
// naming where it was decided and the units it affects, the question, the
// choice, the rationale and its actions (SB-FR-035): Accept as the primary, one
// Overturn for each other option, named by it, and Discuss, which opens the decision's thread while a review
// is open (SB-FR-036): the operator's messages, the session's replies on the
// inset ground, a waiting line while a message has no reply, and a composer
// that sends a message as a volatile thread_message control. The composer is
// disabled, with a notice, while the bench's main session does not run; during
// a run the thread is unavailable and the card says why. After the outcome
// the card leaves the pile, and only its summary stays. A lower card shows
// only its title bar,
// and raises on click or Enter, so a pile of a hundred cards renders one body;
// the raised card takes focus.
// A reviewed card leaves with `drop-away` and the next oldest rises.
//
// The badge reads `to review` while a review is open, `decided` during a run,
// and `queued` while an operator's review control on the decision waits in the
// outbox. Accept and Overturn issue that control; once one is queued, a line
// names when the session reads it (the next unit boundary, or the resume) and
// the actions drop to the disabled opacity. They stay enabled, so a second action supersedes the first,
// until the session has read it. Every text the
// session wrote (the question, the choice, the rationale, a reply, a summary)
// renders as a React text node: never as markup, and never as a link.
//
// A provisional gate the operator has not confirmed is a card on the same pile
// (SB-FR-038, SB-US-014). It lists the gate's provisional marks, each with its
// evidence, in place of the choice and the rationale, and its one action is
// Open sitting: it opens the gate's sitting, with the build pinned at the gate
// commit, where each mark is confirmed or changed. The card leaves the pile once
// every mark is confirmed.

// How long a leaving card stays for its drop-away: motion.duration.fast.
export const REVIEW_DROP_AWAY_MS = 150;

const OUTSTANDING_STATUSES: ReadonlySet<string> = new Set(["pending", "queued", "delivered"]);

interface QueuedAction {
  action: "accept" | "overturn";
  // The session has read it: nothing replaces it now.
  delivered: boolean;
}

// The operator's outstanding review control on a decision, if any: an accept,
// or an overturn, which is also a review outcome.
function queuedAction(
  controls: readonly DeliveryControl[],
  decisionId: string,
): QueuedAction | undefined {
  let queued: QueuedAction | undefined;
  for (const control of controls) {
    if (control.target_id !== decisionId || !OUTSTANDING_STATUSES.has(control.status)) continue;
    const delivered = control.status === "delivered";
    if (control.kind === "review_accept") queued = { action: "accept", delivered };
    else if (control.kind === "overturn") queued = { action: "overturn", delivered };
  }
  return queued;
}

// When the session reads a queued action: at the next unit boundary while the
// delivery runs, else when it resumes.
function readsAt(snapshot: DeliverySnapshot): string {
  const boundary = selectNextBoundary(snapshot);
  if (snapshot.lifecycle.state.toLowerCase() !== "running" || boundary === null) {
    return "on resume";
  }
  return `next boundary: ${boundary.unitId} ${boundary.kind === "finish" ? "finishes" : "starts"}`;
}

type ReviewWord = "to review" | "decided" | "queued";

function reviewWord(reviewOpen: boolean, queued: QueuedAction | undefined): ReviewWord {
  if (queued !== undefined) return "queued";
  return reviewOpen ? "to review" : "decided";
}

// Where the agent decided and what the decision affects.
function originText(decision: DeliveryDecision): string {
  const where = decision.unit_id === undefined ? "the delivery" : decision.unit_id;
  const affected = decision.affected_units ?? [];
  return `agent decided at ${where} · affects ${affected.length > 0 ? affected.join(", ") : "no unit"}`;
}

// A ref that moves focus to its element once `take` holds: a raised card takes
// focus as it rises, so the keyboard stays with the card the operator chose.
function useFocusWhen<T extends HTMLElement>(take: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (take) ref.current?.focus();
  }, [take]);
  return ref;
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

// One entry of a card's thread: an operator's message or a session's reply.
interface ThreadEntry {
  testId: string;
  fromOperator: boolean;
  author: string;
  ts: string;
  text: string;
  // The control_seq of an operator's message.
  controlSeq?: number;
  // The control_seq a session's reply answers, as its in_reply_to names it.
  inReplyTo?: string;
}

// The thread a card shows, and whether an operator's message waits for its
// reply. The operator's messages come from the thread_message controls the
// bench holds in memory (never saved, so a restart drops them) and from the
// stream's read-backs of them (a review.reply with control_seq); the session's
// replies are the other review.reply events, and each names the message it
// answers in in_reply_to. A held message whose read-back is in the stream shows
// once. A held message goes before the first reply that answers it, else at the
// end. A reply whose question the bench no longer holds shows on its own.
function cardThread(
  thread: readonly DeliveryThreadMessage[],
  controls: readonly DeliveryControl[],
  decisionId: string,
): { entries: ThreadEntry[]; waiting: boolean } {
  const entries: ThreadEntry[] = thread.map((message) => {
    const fromOperator = message.controlSeq !== undefined;
    return {
      testId: `review-thread-message-${message.seq}`,
      fromOperator,
      author: fromOperator ? "you" : message.author,
      ts: message.ts,
      text: message.text,
      ...(message.controlSeq !== undefined && { controlSeq: message.controlSeq }),
      ...(!fromOperator && message.inReplyTo !== undefined && { inReplyTo: message.inReplyTo }),
    };
  });
  const echoed = new Set(entries.flatMap((entry) => entry.controlSeq ?? []));
  for (const control of controls) {
    if (
      control.kind !== "thread_message" ||
      control.target_id !== decisionId ||
      !OUTSTANDING_STATUSES.has(control.status) ||
      echoed.has(control.control_seq)
    ) {
      continue;
    }
    const text = (control.body as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const entry: ThreadEntry = {
      testId: `review-thread-control-${control.control_seq}`,
      fromOperator: true,
      author: "you",
      ts: control.issued_at,
      text,
      controlSeq: control.control_seq,
    };
    const answer = entries.findIndex((e) => e.inReplyTo === String(control.control_seq));
    if (answer < 0) entries.push(entry);
    else entries.splice(answer, 0, entry);
  }
  const answered = new Set(entries.flatMap((entry) => entry.inReplyTo ?? []));
  const waiting = entries.some(
    (entry) => entry.controlSeq !== undefined && !answered.has(String(entry.controlSeq)),
  );
  return { entries, waiting };
}

// The time of a message as the clock reads it, or the stamp as it came when it
// does not parse.
function timeOf(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function ThreadMessage({ entry }: { entry: ThreadEntry }) {
  // The operator's message sits on the card ground; the session's reply on
  // the inset ground.
  return (
    <li
      data-testid={entry.testId}
      data-from={entry.fromOperator ? "operator" : "session"}
      className={`animate-rise-in space-y-1 rounded-card p-2 ${entry.fromOperator ? "" : "bg-bg-base"}`}
    >
      <p className="flex gap-2 font-mono text-11 text-text-secondary">
        <span data-testid="review-thread-author" className="font-medium">
          {entry.author}
        </span>
        <time data-testid="review-thread-time" dateTime={entry.ts}>
          {timeOf(entry.ts)}
        </time>
      </p>
      <p className="whitespace-pre-wrap break-words text-13 text-text-body">{entry.text}</p>
    </li>
  );
}

// Why the thread is unavailable during a run.
export const REVIEW_THREAD_UNAVAILABLE =
  "The thread opens at a review: while the delivery runs, the session reads no message.";

// Why the composer is disabled at a review with no live session.
export const REVIEW_THREAD_NO_SESSION =
  "The session is not running, so it reads no message. Discussion opens at a review, with a live session.";

// The label of the waiting line while the session answers.
export const REVIEW_THREAD_WAITING = "session is replying";

function ThreadComposer({
  decisionId,
  sessionLive,
  isSending,
  onSend,
}: {
  decisionId: string;
  sessionLive: boolean;
  isSending: boolean;
  onSend: (text: string, sent: () => void) => void;
}) {
  const [text, setText] = useState("");
  const noticeId = `review-thread-${decisionId}-notice`;
  const disabled = !sessionLive;
  const canSend = !disabled && !isSending && text.trim().length > 0;
  return (
    <>
      <form
        data-testid="review-thread-composer"
        data-disabled={disabled ? "true" : "false"}
        className={`flex items-end gap-2 ${disabled ? "opacity-40" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSend(text, () => setText(""));
        }}
      >
        <TextField
          value={text}
          onChange={setText}
          isDisabled={disabled}
          aria-describedby={disabled ? noticeId : undefined}
          className="flex flex-1 flex-col gap-1"
        >
          <Label className={FIELD_LABEL_CLASS}>Ask about this decision</Label>
          <TextArea rows={2} className={INPUT_CLASS} />
        </TextField>
        <Button type="submit" isDisabled={!canSend}>
          Send
        </Button>
      </form>
      {disabled && (
        <p id={noticeId} data-testid="review-thread-notice" className="text-12 text-text-secondary">
          {REVIEW_THREAD_NO_SESSION}
        </p>
      )}
    </>
  );
}

function TopCard({
  decision,
  word,
  queued,
  readsAtText,
  reviewOpen,
  isSending,
  onAction,
  thread,
  waiting,
  sessionLive,
  isSendingMessage,
  onSendMessage,
  takeFocus,
}: {
  decision: DeliveryDecision;
  word: ReviewWord;
  queued: QueuedAction | undefined;
  readsAtText: string;
  reviewOpen: boolean;
  isSending: boolean;
  onAction: (action: ReviewActionRequest) => void;
  thread: readonly ThreadEntry[];
  waiting: boolean;
  sessionLive: boolean;
  isSendingMessage: boolean;
  onSendMessage: (text: string, sent: () => void) => void;
  // The operator raised this card from below: it takes focus as it rises.
  takeFocus: boolean;
}) {
  const cardRef = useFocusWhen<HTMLElement>(takeFocus);
  const [discussingAtReview, setDiscussing] = useState(false);
  const discussing = reviewOpen && discussingAtReview;
  const threadId = `review-thread-${decision.id}`;
  const actionsDisabled = isSending || queued?.delivered === true;
  const others = decision.options.filter((option) => option !== decision.chosen);
  return (
    <article
      ref={cardRef}
      tabIndex={-1}
      data-testid={`review-card-${decision.id}`}
      data-position="top"
      aria-label={`Agent decision ${decision.id}`}
      className={`${PILE_TOP_CARD} ${focusRing}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge decision={decision} word={word} />
        <span data-testid="review-origin" className="font-mono text-11 text-text-secondary">
          {originText(decision)}
        </span>
      </div>
      <p className="break-words text-13 font-medium text-text-primary">{decision.question}</p>
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
      <div
        data-testid="review-actions"
        data-dimmed={queued !== undefined ? "true" : "false"}
        className={`flex flex-wrap items-center gap-2 ${queued !== undefined ? "opacity-40" : ""}`}
      >
        <Button
          variant="primary"
          isDisabled={actionsDisabled}
          onPress={() => onAction({ kind: "accept", decisionId: decision.id })}
        >
          Accept
        </Button>
        {/* One Overturn for each other option sits between Accept and Discuss,
            so Tab reaches Accept, each Overturn action and Discuss in that
            order (SB-NFR-004). */}
        {others.length > 0 && (
          <div
            role="group"
            aria-label={`Overturn ${decision.id} with`}
            className="flex flex-wrap gap-2"
          >
            {others.map((option) => (
              <Button
                key={option}
                isDisabled={actionsDisabled}
                onPress={() => onAction({ kind: "overturn", decisionId: decision.id, option })}
              >
                Overturn: {option}
              </Button>
            ))}
          </div>
        )}
        <Button
          aria-expanded={discussing}
          aria-controls={discussing ? threadId : undefined}
          aria-describedby={reviewOpen ? undefined : `${threadId}-unavailable`}
          isDisabled={!reviewOpen}
          onPress={() => setDiscussing((open) => !open)}
        >
          Discuss
        </Button>
      </div>
      {!reviewOpen && (
        <p
          id={`${threadId}-unavailable`}
          data-testid="review-thread-unavailable"
          className="text-12 text-text-secondary"
        >
          {REVIEW_THREAD_UNAVAILABLE}
        </p>
      )}
      {queued !== undefined && (
        <p>
          <span
            data-testid="review-queued"
            className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
          >
            {queued.delivered
              ? `${queued.action} read by the session`
              : `${queued.action} queued · ${readsAtText}`}
          </span>
        </p>
      )}
      {discussing && (
        <div id={threadId} data-testid={threadId} className="space-y-2 border-t border-border pt-2">
          {/* A polite log: a reply that arrives is read out while focus stays
              where the operator left it (SB-NFR-004). */}
          <div
            role="log"
            aria-live="polite"
            aria-label={`Messages on ${decision.id}`}
            data-testid="review-thread-log"
          >
            {thread.length === 0 ? (
              <p className="text-12 text-text-secondary">No messages on this decision yet</p>
            ) : (
              <ol aria-label={`Thread of ${decision.id}`} className="space-y-2">
                {thread.map((entry) => (
                  <ThreadMessage key={entry.testId} entry={entry} />
                ))}
              </ol>
            )}
          </div>
          {waiting && (
            <p
              data-testid="review-thread-waiting"
              role="status"
              className="flex items-center gap-1.5 text-11 font-medium text-text-secondary"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-status-pulse rounded-full bg-status-preparing"
              />
              {REVIEW_THREAD_WAITING}
            </p>
          )}
          <ThreadComposer
            decisionId={decision.id}
            sessionLive={sessionLive}
            isSending={isSendingMessage}
            onSend={onSendMessage}
          />
        </div>
      )}
    </article>
  );
}

// The badge of a provisional gate's card: the gate and the count still to
// confirm.
function GateBadge({ gate }: { gate: DeliveryGate }) {
  return (
    <span
      data-testid="review-badge"
      className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
    >
      {gate.id} · {toConfirmText(gateUnconfirmedCount(gate))}
    </span>
  );
}

// Where the agent marked the gate.
function gateOriginText(gate: DeliveryGate): string {
  return `agent marked gate after ${gate.after.join(", ")} · provisional`;
}

function GateTopCard({
  gate,
  isOpening,
  openError,
  onOpenSitting,
  takeFocus,
}: {
  gate: DeliveryGate;
  isOpening: boolean;
  openError: string | undefined;
  onOpenSitting: () => void;
  takeFocus: boolean;
}) {
  const cardRef = useFocusWhen<HTMLElement>(takeFocus);
  const marks = gate.provisionalCases ?? [];
  return (
    <article
      ref={cardRef}
      tabIndex={-1}
      data-testid={`review-card-${gate.id}`}
      data-position="top"
      data-kind="gate"
      aria-label={`Provisional gate ${gate.id}`}
      className={`${PILE_TOP_CARD} ${focusRing}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GateBadge gate={gate} />
        <span data-testid="review-origin" className="font-mono text-11 text-text-secondary">
          {gateOriginText(gate)}
        </span>
      </div>
      <ul
        data-testid="review-provisional-marks"
        aria-label={`Provisional marks of gate ${gate.id}`}
        className="space-y-2"
      >
        {marks.map((entry) => (
          <li key={entry.case}>
            <ProvisionalMarkCard entry={entry} reading={recordedProvisionalMark(entry)} />
          </li>
        ))}
      </ul>
      <div data-testid="review-actions" className="flex flex-wrap items-center gap-2">
        <Button variant="primary" isDisabled={isOpening} onPress={onOpenSitting}>
          Open sitting
        </Button>
      </div>
      {openError !== undefined && (
        <p role="alert" className="text-12 text-danger-text">
          {openError}
        </p>
      )}
    </article>
  );
}

function cardKey(card: ReviewCard): string {
  return `${card.kind}:${card.id}`;
}

export default function ReviewPile({
  projectId,
  benchId,
  snapshot,
  sessionLive = false,
  onSittingOpened,
  raiseRequest,
}: {
  projectId: string;
  benchId: number;
  snapshot: DeliverySnapshot;
  // Whether the bench's main session runs: the composer sends only then.
  sessionLive?: boolean;
  // Called once a gate card's Open sitting opened the gate's sitting, so the
  // bench can show it.
  onSittingOpened?: ((gateId: string) => void) | undefined;
  // A request to raise an agent decision's review card to the top, such as a
  // link of the since-you-left digest (SB-FR-012); each new request raises
  // once, and only a decision on the review stack.
  raiseRequest?: { decisionId: string; nonce: number } | null | undefined;
}) {
  const review = useReviewAction(projectId, benchId);
  const threadMessage = useThreadMessage(projectId, benchId);
  const sittingStage = useSittingStage(projectId, benchId);
  const stack = selectReviewStack(snapshot);
  const cards = stack.flatMap((card) => (card.kind === "decision" ? [card.decision] : []));
  const reviewed = selectReviewedAgentDecisions(snapshot);
  const reviewOpen = snapshot.review.status === "open";
  const [raisedId, setRaisedId] = useState<string | undefined>(undefined);
  const [raisedFor, setRaisedFor] = useState<typeof raiseRequest>(null);
  if (raiseRequest !== undefined && raiseRequest !== null && raiseRequest !== raisedFor) {
    setRaisedFor(raiseRequest);
    const card = stack.find(
      (entry) => entry.kind === "decision" && entry.id === raiseRequest.decisionId,
    );
    if (card !== undefined) setRaisedId(cardKey(card));
  }
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

  if (stack.length === 0 && reviewed.length === 0 && leaving.length === 0) return null;

  const topCard = stack.find((card) => cardKey(card) === raisedId) ?? stack[0];
  const lower = stack.filter((card) => card !== topCard);
  const top = topCard?.kind === "decision" ? topCard.decision : undefined;
  const topGate = topCard?.kind === "gate" ? topCard.gate : undefined;
  const topQueued = top === undefined ? undefined : queuedAction(snapshot.controls, top.id);
  const topThread =
    top === undefined
      ? { entries: [], waiting: false }
      : cardThread(selectDecisionThread(snapshot, top.id), snapshot.controls, top.id);

  const openSitting = (gateId: string) => {
    sittingStage.mutate(
      { action: "open", gateId },
      {
        onSuccess: () => {
          setAnnouncement(`Opened the sitting of gate ${gateId}.`);
          onSittingOpened?.(gateId);
        },
      },
    );
  };

  const sendMessage = (decisionId: string, text: string, sent: () => void) => {
    threadMessage.mutate(
      { decisionId, text },
      {
        onSuccess: () => {
          sent();
          setAnnouncement(`Sent a message on ${decisionId}; the session reads it next.`);
        },
      },
    );
  };

  const act = (action: ReviewActionRequest) => {
    review.mutate(action, {
      onSuccess: () =>
        setAnnouncement(
          action.kind === "accept"
            ? `Accepted ${action.decisionId}, queued until the session reads it.`
            : `Overturned ${action.decisionId} to ${action.option}, queued until the session reads it.`,
        ),
    });
  };

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
          className="animate-drop-away rounded-card border border-border border-l-2 border-l-accent bg-bg-surface p-3"
        >
          <p className="text-13 font-medium text-text-primary">{decision.question}</p>
        </div>
      ))}
      {review.isError && (
        <Callout role="alert" title="The review action was not sent">
          {review.error.message}
        </Callout>
      )}
      {threadMessage.isError && (
        <Callout role="alert" title="The message was not sent">
          {threadMessage.error.message}
        </Callout>
      )}
      {topCard !== undefined && (
        <ul aria-label="Review pile" className="flex flex-col">
          <li key={`top-${cardKey(topCard)}`}>
            {top !== undefined && (
              <TopCard
                key={top.id}
                decision={top}
                word={reviewWord(reviewOpen, topQueued)}
                queued={topQueued}
                readsAtText={readsAt(snapshot)}
                reviewOpen={reviewOpen}
                isSending={review.isPending}
                onAction={act}
                thread={topThread.entries}
                waiting={topThread.waiting}
                sessionLive={sessionLive}
                isSendingMessage={threadMessage.isPending}
                onSendMessage={(text, sent) => sendMessage(top.id, text, sent)}
                takeFocus={raisedId === cardKey(topCard)}
              />
            )}
            {topGate !== undefined && (
              <GateTopCard
                key={topGate.id}
                gate={topGate}
                isOpening={sittingStage.isPending}
                openError={sittingStage.isError ? sittingStage.error.message : undefined}
                onOpenSitting={() => openSitting(topGate.id)}
                takeFocus={raisedId === cardKey(topCard)}
              />
            )}
          </li>
          {lower.map((card) => (
            <li key={cardKey(card)} className={PILE_LOWER_ITEM}>
              <AriaButton
                data-testid={`review-card-${card.id}`}
                data-position="lower"
                data-kind={card.kind}
                onPress={() => setRaisedId(cardKey(card))}
                className={PILE_LOWER_BAR}
              >
                <span className="sr-only">Raise this review card </span>
                {card.kind === "decision" ? (
                  <>
                    <Badge
                      decision={card.decision}
                      word={reviewWord(reviewOpen, queuedAction(snapshot.controls, card.id))}
                    />
                    <span className="min-w-0 break-words font-mono text-11 text-text-secondary">
                      {originText(card.decision)}
                    </span>
                  </>
                ) : (
                  <>
                    <GateBadge gate={card.gate} />
                    <span className="min-w-0 break-words font-mono text-11 text-text-secondary">
                      {gateOriginText(card.gate)}
                    </span>
                  </>
                )}
              </AriaButton>
            </li>
          ))}
        </ul>
      )}
      {reviewed.length > 0 && (
        // The reviewed decisions close the panel as dimmed rows.
        <ul aria-label="Reviewed agent decisions" className="-mx-3 -mb-3 border-t border-border">
          {reviewed.map((decision) => (
            <li
              key={decision.id}
              data-testid={`review-reviewed-${decision.id}`}
              className="space-y-1 border-b border-border px-3 py-1.5 opacity-40 last:border-b-0"
            >
              <p className="break-words font-mono text-11 text-text-secondary">
                {decision.id} · {decision.review?.status} · chose {decision.chosen}
              </p>
              {decision.review?.summary !== undefined && (
                <>
                  <p className="font-mono text-11 font-medium text-text-secondary">
                    discussion summary
                  </p>
                  <p
                    data-testid={`review-summary-${decision.id}`}
                    className="whitespace-pre-wrap break-words text-13 text-text-body"
                  >
                    {decision.review.summary}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
