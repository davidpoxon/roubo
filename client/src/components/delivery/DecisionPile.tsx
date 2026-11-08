import { useEffect, useState, type KeyboardEvent } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { DeliveryControl } from "@roubo/shared/delivery-control-contract";
import type { DeliveryDecision } from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import {
  isDecisionDefaulted,
  selectDecisionHolds,
  selectDecisionPile,
  type DecisionHolds,
} from "@roubo/shared/delivery-selectors";
import Button from "../ui/Button";
import Callout from "../ui/Callout";
import { focusRing } from "../ui/focus-ring";
import { useDecisionControl, type DecisionControlKind } from "../../hooks/useDelivery";
import ReviewPile from "./ReviewPile";

// The decision pile of the Delivery tab (SB-FR-014, SB-FR-015, SB-NFR-004), the
// Decision item of DESIGN.md. Every question the delivery session asked that is
// open, defaulted or overturned sits on the pile, newest on top. The top card is
// live under the 2px accent rule, with its state badge, a mono origin line, the
// question and the options as buttons, the recorded default as the primary. An
// open top card also lists the units the decision holds and the units that
// continue without it (see selectDecisionHolds). A
// lower card shows only its title bar, and raises on click or Enter. A card
// arrives with `slide-under`, a raised card enters with `rise-in`, and a card
// that leaves the pile (its answer landed) leaves with `drop-away`.
//
// An option answers an open decision: Enter or a click sends the answer, which
// waits in the bench's outbox until the session reads it back. A defaulted
// decision shows its default as applied and pending overturn, and Overturn
// offers the other options; an overturned one shows the option that replaced
// its default. The pile announces each change of state in a polite live region.
//
// The decisions the session made on its own in auto mode join the pile as
// Review cards, oldest first, beneath the questions (see ReviewPile).

// How long a leaving card stays for its drop-away: motion.duration.fast.
export const DECISION_DROP_AWAY_MS = 150;

const OUTSTANDING_STATUSES: ReadonlySet<string> = new Set(["pending", "queued", "delivered"]);

type ControlKind = "decision-answer" | "overturn";

// The option of the last outstanding control of a kind that targets a decision.
function outstandingOption(
  controls: readonly DeliveryControl[],
  kind: ControlKind,
  decisionId: string,
): string | undefined {
  let option: string | undefined;
  for (const control of controls) {
    if (control.kind !== kind || control.target_id !== decisionId) continue;
    if (!OUTSTANDING_STATUSES.has(control.status)) continue;
    const body = control.body as { option?: unknown };
    if (typeof body.option === "string") option = body.option;
  }
  return option;
}

type DecisionState =
  | { kind: "open"; pendingAnswer?: string }
  | { kind: "defaulted"; applied: string; pendingOverturn?: string }
  | { kind: "overturned"; applied: string };

function decisionState(
  decision: DeliveryDecision,
  controls: readonly DeliveryControl[],
): DecisionState {
  if (isDecisionDefaulted(decision)) {
    const pendingOverturn = outstandingOption(controls, "overturn", decision.id);
    return {
      kind: "defaulted",
      applied: decision.chosen ?? decision.default,
      ...(pendingOverturn !== undefined && { pendingOverturn }),
    };
  }
  if (decision.status.toLowerCase() === "overturned") {
    return { kind: "overturned", applied: decision.chosen ?? decision.default };
  }
  const pendingAnswer = outstandingOption(controls, "decision-answer", decision.id);
  return { kind: "open", ...(pendingAnswer !== undefined && { pendingAnswer }) };
}

function badgeText(state: DecisionState): string {
  switch (state.kind) {
    case "open":
      return state.pendingAnswer === undefined ? "Open" : "Answer pending";
    case "defaulted":
      return state.pendingOverturn === undefined ? "Default applied" : "Overturn pending";
    case "overturned":
      return "Overturned";
  }
}

// Where the decision was raised and what it holds.
function originText(decision: DeliveryDecision): string {
  const where = decision.unit_id === undefined ? "delivery" : `unit ${decision.unit_id}`;
  return `${decision.id} · ${where} · ${decision.options.length} options · default ${decision.default}`;
}

function Badge({ state }: { state: DecisionState }) {
  return (
    <span
      data-testid="decision-badge"
      className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
    >
      {badgeText(state)}
    </span>
  );
}

// Arrow keys move the focus through a group of buttons, as Tab does.
function moveFocusWithArrows(event: KeyboardEvent<HTMLDivElement>): void {
  const step =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0 && event.key !== "Home" && event.key !== "End") return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
  );
  if (buttons.length === 0) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else next = index < 0 ? 0 : (index + step + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next]?.focus();
}

function OptionButtons({
  decision,
  options,
  label,
  isDisabled,
  onChoose,
}: {
  decision: DeliveryDecision;
  options: readonly string[];
  label: string;
  isDisabled: boolean;
  onChoose: (option: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap gap-2"
      onKeyDown={moveFocusWithArrows}
    >
      {options.map((option) => {
        const isDefault = option === decision.default;
        return (
          <Button
            key={option}
            variant={isDefault ? "primary" : "secondary"}
            isDisabled={isDisabled}
            onPress={() => onChoose(option)}
          >
            {isDefault ? `${option} (default)` : option}
          </Button>
        );
      })}
    </div>
  );
}

// The units an open decision holds and the units that go on without it.
function HoldsList({ decision, holds }: { decision: DeliveryDecision; holds: DecisionHolds }) {
  const named = (ids: readonly string[]) => (ids.length === 0 ? "none" : ids.join(", "));
  return (
    <dl
      aria-label={`Units ${decision.id} holds`}
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-12"
    >
      <dt className="text-text-secondary">Held</dt>
      <dd data-testid="decision-held-units" className="font-mono text-text-primary">
        {named(holds.held)}
      </dd>
      <dt className="text-text-secondary">Continue</dt>
      <dd data-testid="decision-continuing-units" className="font-mono text-text-primary">
        {named(holds.continuing)}
      </dd>
    </dl>
  );
}

function TopCard({
  decision,
  state,
  holds,
  isSending,
  onSend,
}: {
  decision: DeliveryDecision;
  state: DecisionState;
  holds: DecisionHolds;
  isSending: boolean;
  onSend: (kind: DecisionControlKind, option: string) => void;
}) {
  const [overturning, setOverturning] = useState(false);
  return (
    <article
      data-testid={`decision-card-${decision.id}`}
      data-position="top"
      aria-label={`Decision ${decision.id}`}
      className="animate-rise-in space-y-2 rounded-card border border-border border-t-2 border-t-accent bg-bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge state={state} />
        <span className="font-mono text-12 text-text-secondary">{originText(decision)}</span>
      </div>
      <p className="text-13 text-text-primary">{decision.question}</p>

      {state.kind === "open" && (
        <>
          <HoldsList decision={decision} holds={holds} />
          <OptionButtons
            decision={decision}
            options={decision.options}
            label={`Options of ${decision.id}`}
            isDisabled={isSending || state.pendingAnswer !== undefined}
            onChoose={(option) => onSend("answer", option)}
          />
          {state.pendingAnswer !== undefined && (
            <p data-testid="decision-applied" className="text-12 text-text-secondary">
              Answered with {state.pendingAnswer}, pending until the session reads it back.
            </p>
          )}
        </>
      )}

      {state.kind === "defaulted" && (
        <>
          <p data-testid="decision-applied" className="text-12 text-text-body">
            Applied: <span className="text-text-primary">{state.applied}</span> (the default),
            pending overturn.
          </p>
          {state.pendingOverturn !== undefined ? (
            <p className="text-12 text-text-secondary">
              Overturned to {state.pendingOverturn}, pending until the session reads it back.
            </p>
          ) : overturning ? (
            <div className="space-y-2">
              <OptionButtons
                decision={decision}
                options={decision.options.filter((option) => option !== state.applied)}
                label={`Overturn ${decision.id} with`}
                isDisabled={isSending}
                onChoose={(option) => {
                  setOverturning(false);
                  onSend("overturn", option);
                }}
              />
              <Button onPress={() => setOverturning(false)}>Cancel</Button>
            </div>
          ) : (
            <Button onPress={() => setOverturning(true)} isDisabled={isSending}>
              Overturn
            </Button>
          )}
        </>
      )}

      {state.kind === "overturned" && (
        <p data-testid="decision-applied" className="text-12 text-text-body">
          Applied: <span className="text-text-primary">{state.applied}</span>, overturned from the
          default {decision.default}.
        </p>
      )}
    </article>
  );
}

// The announcement for a decision whose state moved from `before` to `after`,
// or undefined when nothing worth saying changed.
function transitionAnnouncement(
  before: DeliveryDecision,
  after: DeliveryDecision | undefined,
): string | undefined {
  if (after === undefined) return undefined;
  if (before.status === after.status && before.chosen === after.chosen) return undefined;
  const status = after.status.toLowerCase();
  if (status === "answered") {
    const answer = (after as { answer?: unknown }).answer;
    return typeof answer === "string"
      ? `${after.id} answered with ${answer}: applied.`
      : `${after.id} answered: applied.`;
  }
  if (isDecisionDefaulted(after)) {
    return `${after.id}: the default ${after.chosen ?? after.default} is applied, pending overturn.`;
  }
  if (status === "overturned") {
    return `${after.id} overturned: ${after.chosen ?? after.default} is applied.`;
  }
  return undefined;
}

export default function DecisionPile({
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
  // Whether the bench's main session runs: a review card's thread takes a
  // message only then.
  sessionLive?: boolean;
  // Called once a provisional gate's review card opened the gate's sitting.
  onSittingOpened?: ((gateId: string) => void) | undefined;
  // A request to raise a decision's card to the top of its pile, such as a
  // link of the since-you-left digest (SB-FR-012); each new request raises
  // once. A decision on this pile raises its card here, an unreviewed agent
  // decision raises its review card, and a request for a decision on neither
  // raises nothing.
  raiseRequest?: { decisionId: string; nonce: number } | null;
}) {
  const pile = selectDecisionPile(snapshot);
  const control = useDecisionControl(projectId, benchId);
  const [raisedId, setRaisedId] = useState<string | undefined>(undefined);
  const [raisedFor, setRaisedFor] = useState<typeof raiseRequest>(null);
  if (raiseRequest !== undefined && raiseRequest !== null && raiseRequest !== raisedFor) {
    setRaisedFor(raiseRequest);
    if (pile.some((decision) => decision.id === raiseRequest.decisionId)) {
      setRaisedId(raiseRequest.decisionId);
    }
  }
  const [announcement, setAnnouncement] = useState("");
  const [leaving, setLeaving] = useState<DeliveryDecision[]>([]);
  const [seen, setSeen] = useState({ pile, byId: snapshot.decisionsById });

  // When the decisions change, announce each change of a decision's state, and
  // keep each card that left the pile for its drop-away. This adjusts state
  // while rendering, as React advises for state derived from a prop change.
  if (seen.byId !== snapshot.decisionsById) {
    const messages: string[] = [];
    for (const decision of Object.values(seen.byId)) {
      const message = transitionAnnouncement(
        decision,
        Object.hasOwn(snapshot.decisionsById, decision.id)
          ? snapshot.decisionsById[decision.id]
          : undefined,
      );
      if (message !== undefined) messages.push(message);
    }
    const stayed = new Set(pile.map((decision) => decision.id));
    const gone = seen.pile.filter((decision) => !stayed.has(decision.id));
    setSeen({ pile, byId: snapshot.decisionsById });
    if (messages.length > 0) setAnnouncement(messages.join(" "));
    if (gone.length > 0) setLeaving((current) => [...current, ...gone]);
  }

  // A leaving card goes once its drop-away has run.
  useEffect(() => {
    if (leaving.length === 0) return undefined;
    const timer = setTimeout(() => setLeaving([]), DECISION_DROP_AWAY_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const top = pile.find((decision) => decision.id === raisedId) ?? pile[0];
  const lower = pile.filter((decision) => decision !== top);

  const send = (kind: DecisionControlKind, decisionId: string, option: string) => {
    control.mutate(
      { kind, decisionId, option },
      {
        onSuccess: () =>
          setAnnouncement(
            kind === "answer"
              ? `Answered ${decisionId} with ${option}, pending until the session reads it back.`
              : `Overturned ${decisionId} to ${option}, pending until the session reads it back.`,
          ),
      },
    );
  };

  return (
    <section data-testid="delivery-decision-controls" aria-label="Decisions" className="space-y-2">
      <div role="status" aria-live="polite" className="sr-only" data-testid="decision-announcer">
        {announcement}
      </div>
      {control.isError && (
        <Callout role="alert" title="The decision control was not sent">
          {control.error.message}
        </Callout>
      )}
      {pile.length === 0 && leaving.length === 0 && (
        <p className="text-13 text-text-secondary">No open decisions</p>
      )}
      {leaving.map((decision) => (
        <div
          key={`leaving-${decision.id}`}
          data-testid={`decision-leaving-${decision.id}`}
          aria-hidden="true"
          className="animate-drop-away rounded-card border border-border border-t-2 border-t-accent bg-bg-surface p-3"
        >
          <p className="text-13 text-text-primary">{decision.question}</p>
        </div>
      ))}
      {top !== undefined && (
        <ul aria-label="Decision pile" className="space-y-2">
          <li key={`top-${top.id}`}>
            <TopCard
              decision={top}
              state={decisionState(top, snapshot.controls)}
              holds={selectDecisionHolds(snapshot, top)}
              isSending={control.isPending}
              onSend={(kind, option) => send(kind, top.id, option)}
            />
          </li>
          {lower.map((decision) => {
            const state = decisionState(decision, snapshot.controls);
            return (
              <li key={decision.id} className="animate-slide-under">
                <AriaButton
                  data-testid={`decision-card-${decision.id}`}
                  data-position="lower"
                  onPress={() => setRaisedId(decision.id)}
                  className={`flex w-full flex-wrap items-center gap-2 rounded-card border border-border bg-bg-surface px-3 py-2 text-left transition-colors data-[hovered]:bg-bg-hover data-[pressed]:bg-bg-pressed ${focusRing}`}
                >
                  <span className="sr-only">Raise decision </span>
                  <Badge state={state} />
                  <span className="font-mono text-12 text-text-secondary">
                    {originText(decision)}
                  </span>
                </AriaButton>
              </li>
            );
          })}
        </ul>
      )}
      <ReviewPile
        projectId={projectId}
        benchId={benchId}
        snapshot={snapshot}
        sessionLive={sessionLive}
        onSittingOpened={onSittingOpened}
        raiseRequest={raiseRequest}
      />
    </section>
  );
}
