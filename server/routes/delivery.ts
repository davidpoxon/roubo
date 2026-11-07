// REST surface of a Spec Bench's delivery (SB-FR-002, SB-FR-003, SB-FR-008,
// SB-FR-009, SB-FR-013, SB-FR-024, SB-FR-029, SB-FR-030, SB-FR-014, SB-FR-015, SB-FR-016, SB-FR-021, SB-FR-022,
// SB-FR-032, SB-FR-034, SB-FR-035).
//
// Endpoints (mounted under /api/projects):
//   GET  /:projectId/benches/:id/delivery         -> 200 DeliverySnapshot: the record,
//                                                    with the accepted events above its
//                                                    last_event_seq (in memory and in the
//                                                    spill file) folded over it, with the
//                                                    spec's plan, results and lifecycle in
//                                                    the workspace for gate state and
//                                                    progress; with `sitting`
//                                                    {gateId, state, commit?,
//                                                    smokeCheck?} while the bench
//                                                    prepares or has a gate sitting
//                                                    (DeliverySnapshotResponse)
//                                                    404 not a Spec Bench
//                                                    409 DeliveryReadError: the record is
//                                                        missing, at an unknown major,
//                                                        missing a section
//                                                        (DELIVERY_NONCONFORMANT + section)
//                                                        or invalid (DELIVERY_INVALID + field)
//   GET  /:projectId/benches/:id/delivery/events?after=<seq>&unit=<id>
//                                                 -> 200 DeliveryEventsResponse
//                                                    {events, acceptedSeq, folded}: the
//                                                    accepted events above `after`
//                                                    (absent: every one above the record's
//                                                    last_event_seq, in memory and in the
//                                                    spill file), only those whose
//                                                    envelope unit_id is `unit` when it
//                                                    is given, in seq order; acceptedSeq
//                                                    is the bench's accepted seq; with
//                                                    `unit`, `folded` counts the unit's
//                                                    accepted events at or below the
//                                                    record's last_event_seq, which the
//                                                    record carries and `events` leaves out
//                                                    400 INVALID_QUERY + field: `after`
//                                                        is not a non-negative integer,
//                                                        or `unit` is not one id
//                                                    404 and 409 as the snapshot read
//   GET  /:projectId/benches/:id/delivery/crosscheck
//                                                 -> 200 DeliveryCrossCheckResponse
//                                                    {disagreements, refreshedAt,
//                                                    sourceError}: the bench's last
//                                                    cross-check (SB-FR-030). The first
//                                                    read since the server started arms
//                                                    the bench's refreshes and waits for
//                                                    its load refresh, at most 4 seconds,
//                                                    then answers what that refresh has
//                                                    read so far. sourceError is
//                                                    null, or {source: "github",
//                                                    message} when the last refresh
//                                                    could not read GitHub, which then
//                                                    keeps the GitHub classes of the
//                                                    refresh before (see
//                                                    services/delivery-cross-check-loader.ts)
//                                                    404 and 409 as the snapshot read
//   POST /:projectId/benches/:id/delivery/launch  -> 202 a launch-mode bench's session
//                                                    launched again with no resume
//                                                    argument, while no record exists
//                                                    yet (the create-time launch failed,
//                                                    or the session ended before it wrote
//                                                    the record)
//                                                    409 DELIVERY_RECORD_PRESENT: the bench
//                                                        has a record; resume instead
//                                                    409 DELIVERY_NOT_LAUNCH_MODE: an
//                                                        attached bench launches no fresh
//                                                        delivery
//                                                    409 a DeliveryReadError other than
//                                                        DELIVERY_RECORD_MISSING
//                                                    409 DELIVERY_SESSION_LIVE and
//                                                        BENCH_UNAVAILABLE, as resume
//   POST /:projectId/benches/:id/delivery/resume  -> 202 the session launched again with
//                                                    the record's resume argument, from a
//                                                    paused, wound down or running
//                                                    lifecycle state (a session that ended
//                                                    without a pause leaves it running)
//                                                    409 WRONG_LIFECYCLE_STATE + state: the
//                                                        lifecycle state is complete, or
//                                                        one the bench does not know
//                                                    409 DELIVERY_SESSION_LIVE + state: the
//                                                        session the bench launched still
//                                                        runs or is starting; `state` and
//                                                        the error name the lifecycle state
//                                                    409 BENCH_UNAVAILABLE: the bench is
//                                                        clearing or in error
//   POST /:projectId/benches/:id/delivery/attach  -> 201 attach mode's token handout: a
//                                                    fresh token in the launch descriptor,
//                                                    for the session that already runs the
//                                                    delivery; launches nothing. The same
//                                                    two 409s as resume.
//   GET  /:projectId/benches/:id/delivery/units/:unitId/diff
//                                                 -> 200 DeliveryUnitDiffResponse
//                                                    {unit, base, head, diff, truncated}:
//                                                    `git diff <base> <head>` in the bench
//                                                    workspace, from the head of the unit
//                                                    below in its stack (or the stack
//                                                    base, the merge base of HEAD and the
//                                                    unit's head) to the unit's head; no
//                                                    GitHub call. base, head null and diff
//                                                    empty while the unit has no head
//                                                    404 UNIT_NOT_FOUND: the record has no
//                                                        such unit
//                                                    409 DELIVERY_DIFF_UNAVAILABLE: a head
//                                                        is not a commit id, or git failed
//                                                    404 and 409 as the snapshot read
//   GET  /:projectId/benches/:id/delivery/units/:unitId/transcript
//                                                 -> 200 DeliveryUnitTranscriptResponse
//                                                    {unit, sessionId, from, to, lines}:
//                                                    the delivery session terminal's
//                                                    scrollback written between the ts of
//                                                    the unit's first and last accepted
//                                                    event, the ones the record already
//                                                    carries included, whose span the
//                                                    bench's span file keeps across a
//                                                    restart; no transcript file
//                                                    404 UNIT_NOT_FOUND, and 404 and 409 as
//                                                        the snapshot read
//   POST /:projectId/benches/:id/delivery/decisions/:decisionId/answer
//        body {option}                          -> 202 DeliveryOutboxControl: a
//                                                    decision-answer control with the
//                                                    next control_seq, status pending,
//                                                    stamped with the operator's git
//                                                    identity as `author`, written to
//                                                    the bench's outbox (state.json)
//                                                    before the answer; the session
//                                                    reads it from GET
//                                                    /api/hooks/delivery-controls. No
//                                                    file in the spec folder changes
//                                                    400 INVALID_BODY + field: `option`
//                                                        is not a non-empty string, or
//                                                        not one of the decision's options
//                                                        (field `option`), or the control
//                                                        fails the control contract
//                                                    404 DECISION_NOT_FOUND: the folded
//                                                        delivery has no such decision
//                                                    409 DECISION_NOT_OPEN: the decision
//                                                        is settled already, a defaulted
//                                                        one included (its default is
//                                                        applied: overturn it instead)
//                                                    409 DECISION_ANSWER_PENDING: an
//                                                        answer to the decision waits for
//                                                        its read-back (`control_seq`)
//                                                    404 and 409 as the snapshot read
//   POST /:projectId/benches/:id/delivery/decisions/:decisionId/overturn
//        body {option}                          -> 202 DeliveryOutboxControl: an
//                                                    overturn control of a defaulted
//                                                    decision (SB-FR-015), issued as an
//                                                    answer is; the session reads it
//                                                    back with a decision.overturned
//                                                    for the decision, or an event that
//                                                    names its control_seq
//                                                    400 INVALID_BODY + field: `option`
//                                                        is not a non-empty string, not
//                                                        one of the decision's options,
//                                                        or the option already applied
//                                                        (field `option`), or the control
//                                                        fails the control contract
//                                                    404 DECISION_NOT_FOUND: as the answer
//                                                    409 DECISION_NOT_DEFAULTED: the
//                                                        decision's status is not
//                                                        `defaulted`
//                                                    409 DECISION_OVERTURN_PENDING: an
//                                                        overturn of the decision waits
//                                                        for its read-back (`control_seq`)
//                                                    404 and 409 as the snapshot read
//                                                 An agent decision (author `agent`) is
//                                                 a review card instead (SB-FR-035): the
//                                                 overturn is a review action, as the
//                                                 accept below, at an open review or
//                                                 during a run
//                                                    202 DeliveryOutboxControl: the
//                                                        overturn control, with
//                                                        `reviewAction: true`, read back by a
//                                                        review.outcome `overturned` for
//                                                        the decision
//                                                    400 INVALID_OPTION + field `option`:
//                                                        not one of the decision's options,
//                                                        or the option it chose already
//                                                    409 ALREADY_REVIEWED and 409
//                                                        REVIEW_ACTION_DELIVERED, as the
//                                                        accept
//   POST /:projectId/benches/:id/delivery/decisions/:decisionId/accept
//        body {summary?}                        -> 202 DeliveryOutboxControl: a
//                                                    review_accept control of an agent
//                                                    decision (SB-FR-035), with
//                                                    `reviewAction: true`, issued as an
//                                                    answer is, at an open review or
//                                                    during a run; the session reads it
//                                                    back with a review.outcome
//                                                    `accepted` for the decision
//                                                    400 INVALID_BODY + field: `summary`
//                                                        is given and not a string, or the
//                                                        control fails the control contract
//                                                    404 DECISION_NOT_FOUND: as the answer
//                                                    409 NOT_AGENT_DECISION: the session
//                                                        asked the decision; answer it
//                                                    409 ALREADY_REVIEWED: a review.outcome
//                                                        for the decision landed
//                                                    409 REVIEW_ACTION_DELIVERED: the
//                                                        tooling has read a review action
//                                                        on the decision (`control_seq`)
//                                                    404 and 409 as the snapshot read
//                                                 A review action (an accept, or an
//                                                 overturn of an agent decision) is
//                                                 idempotent: the same action again,
//                                                 with the same option for an overturn,
//                                                 answers 202 with the control already
//                                                 pending. Another action before the
//                                                 tooling reads supersedes the pending
//                                                 one, which then reads `superseded` and
//                                                 leaves the controls read. The read
//                                                 that serves a review action marks it
//                                                 `delivered`. A review.outcome for the
//                                                 decision with the other outcome marks
//                                                 the action `superseded`.
//   POST /:projectId/benches/:id/delivery/decisions/:decisionId/thread
//        body {text}                            -> 202 DeliveryOutboxControl: a
//                                                    volatile thread_message control
//                                                    of an agent decision (SB-FR-036),
//                                                    status queued, held in memory
//                                                    for the next controls read
//                                                    only and never saved; the
//                                                    session answers with a
//                                                    review.reply whose in_reply_to
//                                                    names its control_seq
//                                                    400 INVALID_TEXT + field `text`:
//                                                        not a string, blank, or longer
//                                                        than the contract allows
//                                                    404 DECISION_NOT_FOUND: as the answer
//                                                    409 NOT_AGENT_DECISION: as the accept
//                                                    409 THREAD_UNAVAILABLE + reason:
//                                                        `no_review` when no review is
//                                                        open or the decision is
//                                                        reviewed already, `no_session`
//                                                        when the bench's main session
//                                                        does not run
//                                                    404 and 409 as the snapshot read
//   POST /:projectId/benches/:id/delivery/steering
//        body {text, applies_at}                -> 202 DeliveryOutboxControl: a
//                                                    steering-note control with
//                                                    body {note: text, unit_ids: [],
//                                                    applies_at} (every unit after
//                                                    the boundary `applies_at`
//                                                    names), issued as an answer is
//                                                    (SB-FR-016); the session reads
//                                                    it back with a steering.added
//                                                    whose payload names its
//                                                    control_seq, and only then is
//                                                    the note applied
//                                                    400 INVALID_BODY + field: `text`
//                                                        is not a non-blank string,
//                                                        `applies_at` is not a
//                                                        non-empty string, or the
//                                                        control fails the control
//                                                        contract
//                                                    404 and 409 as the snapshot read
//   PUT  /:projectId/benches/:id/delivery/roles
//        body {role, tier}                    -> 202 DeliveryOutboxControl: a
//                                                    role-change control with target_id
//                                                    the role and body {tier}, issued as
//                                                    an answer is (SB-FR-021); the
//                                                    session reads it back with a
//                                                    roles.applied {role, tier,
//                                                    control_seq}, which makes the tier
//                                                    the role's current one
//                                                    400 INVALID_BODY + field: `role` is
//                                                        not a role of the folded record,
//                                                        `tier` is not a non-blank string,
//                                                        or the control fails the control
//                                                        contract
//                                                    404 and 409 as the snapshot read
//   PUT  /:projectId/benches/:id/delivery/mode
//        body {mode}                          -> 202 DeliveryOutboxControl: a
//                                                    mode_switch control of the
//                                                    delivery, with no target and
//                                                    body {mode}, issued as an answer
//                                                    is (SB-FR-032); the session reads
//                                                    it back with a mode.changed
//                                                    {value, control_seq}, which makes
//                                                    the mode the one in effect. The
//                                                    same mode again while that switch
//                                                    waits answers 202 with it
//                                                    400 INVALID_BODY + field `mode`:
//                                                        not `attended` or `auto`
//                                                    409 MODE_UNCHANGED + mode: the
//                                                        mode is in effect already and
//                                                        no switch is pending
//                                                    404 and 409 as the snapshot read
//                                                 No cross-check and no lifecycle
//                                                 state blocks it.
//   POST /:projectId/benches/:id/delivery/pause
//        body {reason?}                       -> 202 DeliveryOutboxControl: a pause
//                                                    control of the delivery, with no
//                                                    target, issued as an answer is
//                                                    (SB-FR-022), from the running state
//   POST /:projectId/benches/:id/delivery/wind-down
//        body {reason?}                       -> 202 DeliveryOutboxControl: a wind-down
//                                                    control, as the pause, from the
//                                                    running or the paused state
//                                                 Both:
//                                                    400 INVALID_BODY + field: `reason`
//                                                        is given and not a string
//                                                    409 WRONG_LIFECYCLE_STATE + state:
//                                                        the folded record's lifecycle
//                                                        state, which the error names, is
//                                                        not one the action is open in
//                                                    404 and 409 as the snapshot read
//   POST /:projectId/benches/:id/delivery/approve
//        body {reason?}                       -> 202 DeliveryOutboxControl: an
//                                                    approval control of the delivery,
//                                                    with no target, issued as an answer
//                                                    is
//                                                    400 INVALID_BODY + field: `reason`
//                                                        is given and not a string
//                                                 409 the first refusal of the checks, in
//                                                 this order (selectApprovalRefusal,
//                                                 which the Approve control reads too):
//                                                    409 WRONG_LIFECYCLE_STATE + state:
//                                                        the delivery is complete, or in a
//                                                        state the bench does not know
//                                                    409 CROSSCHECK_BLOCKED + classes: the
//                                                        bench's last cross-check holds a
//                                                        disagreement of a blocking class
//                                                        (branch-missing,
//                                                        head-commit-differs,
//                                                        pr-state-differs,
//                                                        gate-state-differs or
//                                                        plan-hash-mismatch); `classes`
//                                                        names each one present
//                                                    409 PROVISIONAL_UNCONFIRMED + gates:
//                                                        the folded record states a gate
//                                                        as `provisional` (`gates` lists
//                                                        them)
//                                                    409 REVIEW_OPEN: the folded record's
//                                                        review status is `open`
//                                                        (`unreviewed` lists the decisions
//                                                        it waits on)
//                                                    409 GATING_UNMET + gates: a gate's
//                                                        gating cases are not all met, read
//                                                        from the spec's plan and results
//                                                        in the workspace as the snapshot
//                                                        reads them (`gates` lists them)
//                                                    404 and 409 as the snapshot read
//   POST /:projectId/benches/:id/delivery/sittings
//        body {gateId}                        -> 201 BenchDeliverySitting {gateId,
//                                                    openedAt, commit, state: "open",
//                                                    smokeCheck {passed, checkedAt,
//                                                    detail?}, resultsSpecPath}: the
//                                                    gate sitting the bench now has
//                                                    open, kept on the bench
//                                                    (deliverySitting).
//                                                    When a gate.reached prepared the
//                                                    gate's sitting (SB-FR-023, see
//                                                    services/delivery-sitting.ts),
//                                                    the pin is in place already: a
//                                                    `ready` sitting, whose smoke
//                                                    check passed, opens (also
//                                                    preparedAt), and the gate's
//                                                    delivery-sitting notification
//                                                    goes; a `preparing` one, whose
//                                                    smoke check has not passed, is
//                                                    refused with 409
//                                                    BUILD_NOT_SMOKE_CHECKED saying
//                                                    the build is not smoke-checked,
//                                                    and nothing moves.
//                                                    With no prepared sitting, the
//                                                    gate pin service (SB-FR-024, see
//                                                    services/gate-pin.ts) stopped the
//                                                    components, added a detached
//                                                    worktree at `<workspacePath>-pin`
//                                                    at the gate commit (for a commit
//                                                    of a mapped submodule of a
//                                                    meta-repo: at the workspace's
//                                                    commit, with that submodule at
//                                                    the gate commit), initialised its
//                                                    submodules, ran benches.setup and
//                                                    marked the components' one-time
//                                                    setup to run in it, recorded
//                                                    gatePin {gateId, workspacePath,
//                                                    commit, submodulePath?,
//                                                    workspaceSetupDone?, createdAt},
//                                                    restarted the components that
//                                                    ran, from the pin on the bench's
//                                                    ports, waited for each launch to
//                                                    settle, and smoke-checked them:
//                                                    each runs, each http(s) URL it
//                                                    reports answers below 500, and
//                                                    the pin is at the gate commit.
//                                                    The answer comes only after that
//                                                    check passed. The gate commit is
//                                                    the head of the top unit the gate
//                                                    runs after.
//                                                    resultsSpecPath is the workspace's
//                                                    spec folder, which holds
//                                                    test-results.json during the
//                                                    sitting. The same gate again
//                                                    answers 202 with the sitting
//                                                    already open
//                                                    400 INVALID_BODY + field `gateId`:
//                                                        not a non-empty string
//                                                    404 GATE_NOT_FOUND: the folded
//                                                        delivery has no such gate
//                                                 409 the first refusal of the checks, in
//                                                 this order (selectSittingRefusal):
//                                                    409 WRONG_LIFECYCLE_STATE + state:
//                                                        as the approve
//                                                    409 CROSSCHECK_BLOCKED + classes:
//                                                        as the approve, less an entry
//                                                        whose `sittingExempt` names
//                                                        this gate (it claims a verdict
//                                                        over the gate's unconfirmed
//                                                        provisional marks)
//                                                    409 SITTING_OPEN + gateId: a sitting
//                                                        of another gate is open, ready
//                                                        or being prepared
//                                                    409 BUILD_NOT_SMOKE_CHECKED: the
//                                                        gate's prepared sitting waits
//                                                        for its build (as above)
//                                                 then, with no prepared sitting, once
//                                                 no check refuses:
//                                                    409 GATE_COMMIT_MISSING + gateId:
//                                                        the record names no head for
//                                                        the gate's top unit
//                                                    400 GATE_COMMIT_UNKNOWN: git does
//                                                        not know the gate commit; no
//                                                        worktree is created and the
//                                                        components are untouched
//                                                    409 SITTING_BUSY: another open or
//                                                        close of the bench's sitting
//                                                        runs
//                                                    409 GATE_PIN_PATH_TAKEN: a
//                                                        directory git cannot remove
//                                                        holds the pin path
//                                                    409 GATE_PIN_LEFTOVER: the bench
//                                                        holds a gate pin with no
//                                                        sitting (an open that a server
//                                                        stop cut short); nothing moves,
//                                                        and DELETE .../sittings/current
//                                                        releases it
//                                                    500 GATE_PIN_FAILED: git could not
//                                                        add the worktree, or the pin is
//                                                        not at the gate commit; the pin
//                                                        is removed and the components
//                                                        that ran restart from the
//                                                        workspace
//                                                    409 BUILD_NOT_SMOKE_CHECKED: the
//                                                        pin's submodules or setup
//                                                        failed, or the smoke check of
//                                                        its restarted components did;
//                                                        the pin is removed, the
//                                                        workspace's setup flags come
//                                                        back, and the components that
//                                                        ran restart from the workspace
//                                                    404 and 409 as the snapshot read
//   DELETE /:projectId/benches/:id/delivery/sittings/current
//                                                 -> 204 the sitting closed, in any state
//                                                    (preparing, ready or open): the
//                                                    gate pin service stopped the
//                                                    components, removed the pin
//                                                    worktree, cleared gatePin and
//                                                    deliverySitting, restored the
//                                                    workspace's setup flags,
//                                                    dismissed the gate's
//                                                    delivery-sitting notification,
//                                                    and restarted the components
//                                                    that ran, from the workspace,
//                                                    after each launch settled
//                                                    404 SITTING_NOT_FOUND: the bench
//                                                        has no sitting and no pin
//                                                    404 not a Spec Bench
//                                                    409 SITTING_BUSY: as the open
//                                                    500 GATE_PIN_FAILED: git could not
//                                                        remove the pin; the sitting
//                                                        stays open
//
// The cross-check's blocking classes (SB-FR-029) refuse a gate sitting and the
// approval only. The four other classes (layer-order-differs,
// base-branch-differs, case-status-differs and record-stale) are shown on the
// rail and block nothing. Decision answers, steering notes, pause, wind-down,
// resume and the mode switch never read the cross-check, so they answer as
// above under every class.
//
// The session posts its events to POST /api/hooks/delivery-event (see
// delivery-hooks.ts), which checks the delivery token. Launch, resume and the
// attach handout are operator actions on the local API, which checks no caller,
// like the other bench routes. The handout's body carries the plain token, so it
// is sent with Cache-Control: no-store and nothing here logs it.
//
// The record is `.specifications/<slug>/delivery-observation.json` inside the
// bench workspace. It is read and validated on every request (see
// delivery-record-loader), so nothing a view shows comes from a record that no
// longer conforms.
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { Bench } from "@roubo/shared";
import {
  benchDeliveryEventSpillPath,
  deliverySpecFolder,
  loadBenchDeliveryRecord,
  loadBenchDeliveryVerifyInputs,
} from "../lib/delivery-record-loader.js";
import { foldDeliverySnapshot } from "../lib/delivery-snapshot.js";
import { UnsafePathError } from "../lib/safe-path.js";
import * as benchManager from "../services/bench-manager.js";
import {
  closeGatePin,
  GatePinError,
  openGatePin,
  openPreparedSitting,
} from "../services/gate-pin.js";
import { gateCommitOf } from "../services/delivery-sitting.js";
import {
  DELIVERY_DIFF_MAX_BYTES,
  type DeliveryCrossCheckResponse,
  type DeliveryEventsResponse,
  type DeliverySnapshotResponse,
  type DeliveryUnitDiffResponse,
  type DeliveryUnitTranscriptResponse,
} from "@roubo/shared/delivery-bench";
import {
  AGENT_AUTHOR,
  DELIVERY_TEXT_MAX_LENGTH,
  type DeliveryDecision,
  type DeliveryEvent,
  type DeliveryRecord,
  type DeliveryUnit,
} from "@roubo/shared/delivery-observation-contract";
import type { Author } from "@roubo/shared/testbench-contracts";
import type { DeliveryControlKind } from "@roubo/shared/delivery-control-contract";
import {
  foldDelivery,
  isDecisionDefaulted,
  isDecisionOpen,
  isModeValue,
  ownValue,
  type DeliverySnapshot,
} from "@roubo/shared/delivery-reducer";
import {
  selectApprovalRefusal,
  selectLifecycleAction,
  selectSittingRefusal,
  type DeliveryLifecycleAction,
} from "@roubo/shared/delivery-selectors";
import {
  deliveryAcceptedSeq,
  deliveryEventsAfterRecord,
  deliveryUnitEventSpan,
} from "../services/delivery-event-log.js";
import { readDeliveryCrossCheck } from "../services/delivery-cross-check-loader.js";
import { runCommand } from "../services/exec.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import {
  deliveryCardControlsOf,
  deliveryControlsOf,
  isControlOutstanding,
  isReviewControl,
  issueDeliveryControl,
} from "../services/delivery-control-outbox.js";
import { broadcastDeliveryFrame } from "../services/sse.js";
import { getSession, getSessionScrollback } from "../services/terminal.js";
import {
  DeliveryLaunchBlockedError,
  deliveryLaunchBlock,
  handOutDeliveryToken,
  launchDeliverySession,
  whenDeliveryBound,
  type DeliveryLaunchBlock,
} from "../services/delivery-session-launcher.js";

const router = Router();

// Every handler reads the record from disk, so each is rate-limited (CodeQL
// js/missing-rate-limiting).
const deliveryReadRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const deliveryWriteRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

function specBenchOf(req: Request, res: Response): Bench | undefined {
  const projectId = String(req.params.projectId);
  const benchId = Number(req.params.id);
  const bench = Number.isInteger(benchId) ? benchManager.getBench(projectId, benchId) : undefined;
  if (!bench) {
    res.status(404).json({ error: "Bench not found", code: "NOT_FOUND" });
    return undefined;
  }
  if (bench.variant !== "specbench" || !bench.focusedSpecPath) {
    res.status(404).json({ error: "Bench is not a Spec Bench", code: "NOT_SPEC_BENCH" });
    return undefined;
  }
  return bench;
}

// A launch, a resume or a handout mints a new token, which revokes the one
// before it, so none goes ahead while the bench's own session runs or the bench
// is going.
// A resume passes the record's lifecycle state, which the refusal then names.
function sendLaunchBlocked(
  res: Response,
  bench: Bench,
  block: DeliveryLaunchBlock,
  lifecycleState?: string,
): void {
  if (block === "session_live") {
    res.status(409).json({
      error:
        lifecycleState === undefined
          ? "The delivery session of this bench is still running"
          : `The delivery is ${lifecycleState} and the delivery session of this bench is still running`,
      code: "DELIVERY_SESSION_LIVE",
      ...(bench.deliverySessionId !== undefined && { sessionId: bench.deliverySessionId }),
      ...(lifecycleState !== undefined && { state: lifecycleState }),
    });
    return;
  }
  res.status(409).json({
    error: `The bench is ${block === "clearing" ? "being cleared" : "in error"}`,
    code: "BENCH_UNAVAILABLE",
    status: block,
  });
}

router.get("/:projectId/benches/:id/delivery", deliveryReadRateLimiter, (req, res) => {
  const bench = specBenchOf(req, res);
  if (!bench) return;
  const loaded = loadBenchDeliveryRecord(bench);
  if (!loaded.ok) {
    res.status(409).json(loaded.error);
    return;
  }
  // Reading the events also seeds the bench's accepted seq from the record, so
  // after a restart the bench goes on from the record's last_event_seq.
  const events = deliveryEventsAfterRecord(
    bench.projectId,
    bench.id,
    loaded.record,
    benchDeliveryEventSpillPath(bench),
  );
  // The plan, the results and the lifecycle give the gates their state and the
  // progress its cases met and requirements covered (SB-FR-011): a retired or
  // superseded case reads as the gates route reads it.
  const verify = loadBenchDeliveryVerifyInputs(bench);
  const snapshot = foldDeliverySnapshot({
    record: loaded.record,
    events,
    ...verify,
    // The served thread messages too, so a review card keeps its question
    // while the session answers.
    controls: deliveryCardControlsOf(bench),
    now: Date.now(),
  });
  // The gate sitting the bench prepares or has open (SB-FR-023), so the gate
  // reads waiting for build or ready to sit.
  const sitting = bench.deliverySitting;
  const body: DeliverySnapshotResponse =
    sitting === undefined
      ? snapshot
      : {
          ...snapshot,
          sitting: {
            gateId: sitting.gateId,
            state: sitting.state ?? "open",
            ...(sitting.commit !== undefined && { commit: sitting.commit }),
            ...(sitting.smokeCheck !== undefined && { smokeCheck: sitting.smokeCheck }),
          },
        };
  res.json(body);
});

function sendInvalidQuery(res: Response, field: string, error: string): void {
  res.status(400).json({ error, code: "INVALID_QUERY", field });
}

router.get("/:projectId/benches/:id/delivery/events", deliveryReadRateLimiter, (req, res) => {
  const bench = specBenchOf(req, res);
  if (!bench) return;
  const { after: rawAfter, unit } = req.query;
  let after: number | undefined;
  if (rawAfter !== undefined) {
    if (typeof rawAfter !== "string" || !/^\d+$/.test(rawAfter)) {
      sendInvalidQuery(res, "after", "after must be a non-negative integer seq");
      return;
    }
    after = Number(rawAfter);
    if (!Number.isSafeInteger(after)) {
      sendInvalidQuery(res, "after", "after must be a non-negative integer seq");
      return;
    }
  }
  if (unit !== undefined && (typeof unit !== "string" || unit.length === 0)) {
    sendInvalidQuery(res, "unit", "unit must name one unit id");
    return;
  }
  const loaded = loadBenchDeliveryRecord(bench);
  if (!loaded.ok) {
    res.status(409).json(loaded.error);
    return;
  }
  // The log keeps the events above the record's last_event_seq only, already
  // in seq order, so the filters keep that order.
  const accepted = deliveryEventsAfterRecord(
    bench.projectId,
    bench.id,
    loaded.record,
    benchDeliveryEventSpillPath(bench),
  );
  const events = accepted.filter(
    (event) =>
      (after === undefined || event.seq > after) && (unit === undefined || event.unit_id === unit),
  );
  const body: DeliveryEventsResponse = {
    events,
    acceptedSeq: deliveryAcceptedSeq(bench.projectId, bench.id) ?? loaded.record.last_event_seq,
  };
  if (unit !== undefined) {
    body.folded =
      deliveryUnitEventSpan(
        bench.projectId,
        bench.id,
        loaded.record,
        unit,
        benchDeliveryEventSpillPath(bench),
      )?.folded ?? 0;
  }
  res.json(body);
});

router.get(
  "/:projectId/benches/:id/delivery/crosscheck",
  deliveryReadRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const loaded = loadBenchDeliveryRecord(bench);
    if (!loaded.ok) {
      res.status(409).json(loaded.error);
      return;
    }
    const body: DeliveryCrossCheckResponse = await readDeliveryCrossCheck(bench);
    res.json(body);
  },
);

// ── Unit drill-in reads (SB-FR-013) ──

// A unit's head and the lower layer's head are commits the session wrote into
// the record, so only a hex object name reaches git: nothing that git could
// read as an option or a revision expression.
const COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const DIFF_TIMEOUT_MS = 15_000;

interface DrillInContext {
  bench: Bench;
  record: DeliveryRecord;
  snapshot: DeliverySnapshot;
  events: readonly DeliveryEvent[];
  unit: DeliveryUnit;
}

// The bench, its folded record and its accepted events, and the unit the path
// names; or the answer already sent when any of them is missing.
function drillInContext(req: Request, res: Response): DrillInContext | undefined {
  const bench = specBenchOf(req, res);
  if (!bench) return undefined;
  const loaded = loadBenchDeliveryRecord(bench);
  if (!loaded.ok) {
    res.status(409).json(loaded.error);
    return undefined;
  }
  const events = deliveryEventsAfterRecord(
    bench.projectId,
    bench.id,
    loaded.record,
    benchDeliveryEventSpillPath(bench),
  );
  // The pure fold, not the route's memoised one: this read needs the units
  // only, and leaves the memo to the snapshot read.
  const snapshot = foldDelivery({ record: loaded.record, events });
  const unitId = String(req.params.unitId);
  const unit = ownValue(snapshot.unitsById, unitId);
  if (unit === undefined) {
    res.status(404).json({ error: `The delivery has no unit ${unitId}`, code: "UNIT_NOT_FOUND" });
    return undefined;
  }
  return { bench, record: loaded.record, snapshot, events, unit };
}

function sendDiffUnavailable(res: Response, error: string): void {
  res.status(409).json({ error, code: "DELIVERY_DIFF_UNAVAILABLE" });
}

// The head of the unit right below this one in its stack, when it has one.
function lowerLayerHead(snapshot: DeliverySnapshot, unit: DeliveryUnit): string | undefined {
  const members = ownValue(snapshot.stacks, unit.stack) ?? [];
  const index = members.indexOf(unit.id);
  if (index <= 0) return undefined;
  const lowerId = members[index - 1];
  return lowerId === undefined ? undefined : ownValue(snapshot.unitsById, lowerId)?.head;
}

router.get(
  "/:projectId/benches/:id/delivery/units/:unitId/diff",
  deliveryReadRateLimiter,
  async (req, res) => {
    const context = drillInContext(req, res);
    if (!context) return;
    const { bench, snapshot, unit } = context;
    const head = unit.head;
    if (head === undefined || head.length === 0) {
      const body: DeliveryUnitDiffResponse = {
        unit: unit.id,
        base: null,
        head: null,
        diff: "",
        truncated: false,
      };
      res.json(body);
      return;
    }
    if (!COMMIT_RE.test(head)) {
      sendDiffUnavailable(res, `The head of ${unit.id} is not a commit id: ${head}`);
      return;
    }
    let base = lowerLayerHead(snapshot, unit);
    if (base !== undefined && !COMMIT_RE.test(base)) {
      sendDiffUnavailable(res, `The head below ${unit.id} is not a commit id: ${base}`);
      return;
    }
    const cwd = bench.workspacePath;
    if (base === undefined) {
      // The stack base: where the unit's history leaves the workspace's own.
      const mergeBase = await runCommand(
        "git",
        ["merge-base", "HEAD", head],
        cwd,
        undefined,
        DIFF_TIMEOUT_MS,
      );
      const found = mergeBase.stdout.trim();
      if (mergeBase.code !== 0 || !COMMIT_RE.test(found)) {
        sendDiffUnavailable(
          res,
          `The stack base of ${unit.id} could not be found in the bench workspace: ${firstLine(mergeBase.stderr)}`,
        );
        return;
      }
      base = found;
    }
    const diff = await runCommand(
      "git",
      ["diff", "--no-color", "--no-ext-diff", base, head, "--"],
      cwd,
      undefined,
      DIFF_TIMEOUT_MS,
    );
    if (diff.code !== 0) {
      sendDiffUnavailable(
        res,
        `git diff of ${unit.id} failed in the bench workspace: ${firstLine(diff.stderr)}`,
      );
      return;
    }
    const bytes = Buffer.from(diff.stdout, "utf8");
    const truncated = bytes.length > DELIVERY_DIFF_MAX_BYTES;
    const body: DeliveryUnitDiffResponse = {
      unit: unit.id,
      base,
      head,
      diff: truncated ? bytes.subarray(0, DELIVERY_DIFF_MAX_BYTES).toString("utf8") : diff.stdout,
      truncated,
    };
    res.json(body);
  },
);

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

router.get(
  "/:projectId/benches/:id/delivery/units/:unitId/transcript",
  deliveryReadRateLimiter,
  (req, res) => {
    const context = drillInContext(req, res);
    if (!context) return;
    const { bench, record, unit } = context;
    // The log's span of the unit, not the events above the record only: once
    // the record carries a finished unit's events, they leave the log, and the
    // span keeps their times, in the bench's span file across a restart too.
    const span = deliveryUnitEventSpan(
      bench.projectId,
      bench.id,
      record,
      unit.id,
      benchDeliveryEventSpillPath(bench),
    );
    const from = span?.from ?? null;
    const to = span?.to ?? null;
    const sessionId = bench.deliverySessionId ?? null;
    let lines: string[] = [];
    let session: string | null = null;
    if (sessionId !== null) {
      const fromMs = from === null ? Number.NaN : Date.parse(from);
      const toMs = to === null ? Number.NaN : Date.parse(to);
      // A span that does not parse holds no chunk.
      const scrollback = getSessionScrollback(sessionId, fromMs, toMs);
      if (scrollback !== undefined) {
        session = sessionId;
        lines = scrollback;
      }
    }
    const body: DeliveryUnitTranscriptResponse = {
      unit: unit.id,
      sessionId: session,
      from,
      to,
      lines,
    };
    res.json(body);
  },
);

// ── Controls (SB-FR-014, SB-FR-021) ──

// An operator answers decisions one after another, so the limit is wider than
// a launch's.
const deliveryControlRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

function sendInvalidBody(res: Response, field: string, error: string): void {
  res.status(400).json({ error, code: "INVALID_BODY", field });
}

// What every operator control needs: the Spec Bench, the operator's identity
// and the folded delivery.
interface ControlContext {
  bench: Bench;
  record: DeliveryRecord;
  snapshot: DeliverySnapshot;
  author: Author;
  // The disagreements of the bench's last cross-check, read only for a control
  // the cross-check can block (`crossCheck`); empty otherwise.
  disagreements: DeliveryCrossCheckResponse["disagreements"];
}

interface DecisionControlContext extends ControlContext {
  decisionId: string;
  decision: DeliveryDecision;
  option: string;
}

// The operator's identity and the folded delivery of the bench; or the answer
// already sent when the record cannot be read. With `verify`, the fold also
// reads the spec's plan, results and lifecycle in the workspace, as the
// snapshot read does, so the gates carry their evaluated state. With
// `crossCheck`, it also reads the bench's last cross-check (SB-FR-029), which a
// gate sitting and the approval consult at control time.
async function controlContext(
  bench: Bench,
  res: Response,
  options: { verify?: boolean; crossCheck?: boolean } = {},
): Promise<ControlContext | undefined> {
  // The operator Roubo knows: the git identity of the bench workspace, in the
  // results writer's Author shape. Resolved before the checks, so nothing
  // awaits between the checks and the issue.
  const identity = await resolveGitIdentity(bench.workspacePath);
  // The last cross-check, read before the checks for the same reason. Only a
  // record that loads arms the bench's cross-check, as the crosscheck read.
  let disagreements: DeliveryCrossCheckResponse["disagreements"] = [];
  if (options.crossCheck === true && loadBenchDeliveryRecord(bench).ok) {
    disagreements = (await readDeliveryCrossCheck(bench)).disagreements;
  }
  const loaded = loadBenchDeliveryRecord(bench);
  if (!loaded.ok) {
    res.status(409).json(loaded.error);
    return undefined;
  }
  const events = deliveryEventsAfterRecord(
    bench.projectId,
    bench.id,
    loaded.record,
    benchDeliveryEventSpillPath(bench),
  );
  const snapshot = foldDelivery({
    record: loaded.record,
    events,
    ...(options.verify === true && loadBenchDeliveryVerifyInputs(bench)),
  });
  return {
    bench,
    record: loaded.record,
    snapshot,
    author:
      identity.isSentinel === true
        ? { name: identity.name, email: identity.email, isSentinel: true }
        : { name: identity.name, email: identity.email },
    disagreements,
  };
}

// The decision the path names in the folded delivery; or the 404 already sent.
function pathDecision(
  req: Request,
  res: Response,
  snapshot: DeliverySnapshot,
): { decisionId: string; decision: DeliveryDecision } | undefined {
  const decisionId = String(req.params.decisionId);
  const decision = ownValue(snapshot.decisionsById, decisionId);
  if (decision === undefined) {
    res
      .status(404)
      .json({ error: `The delivery has no decision ${decisionId}`, code: "DECISION_NOT_FOUND" });
    return undefined;
  }
  return { decisionId, decision };
}

// What a decision control needs: the Spec Bench, a non-empty `option` in the
// body, the operator's identity, the folded delivery and the decision the path
// names; or the answer already sent when any of them is missing.
async function decisionControlContext(
  req: Request,
  res: Response,
): Promise<DecisionControlContext | undefined> {
  const bench = specBenchOf(req, res);
  if (!bench) return undefined;
  const option: unknown = (req.body as { option?: unknown } | undefined)?.option;
  if (typeof option !== "string" || option.length === 0) {
    sendInvalidBody(res, "option", "option must be a non-empty string");
    return undefined;
  }
  const context = await controlContext(bench, res);
  if (!context) return undefined;
  const target = pathDecision(req, res, context.snapshot);
  if (!target) return undefined;
  return { ...context, ...target, option };
}

// The optional text field `key` of the body; or the 400 already sent when it is
// there and not a string.
function optionalBodyText(
  req: Request,
  res: Response,
  key: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const value: unknown = (req.body as Record<string, unknown> | undefined)?.[key];
  if (value !== undefined && typeof value !== "string") {
    sendInvalidBody(res, key, `${key} must be a string when it is given`);
    return { ok: false };
  }
  return { ok: true, value };
}

// Issues a control and answers 202 with it, or 400 when it fails the control
// contract. `review` marks a review action on an agent decision, with the
// pending review actions it supersedes.
function issueControl(
  res: Response,
  context: ControlContext,
  kind: DeliveryControlKind,
  targetId: string | undefined,
  body: Record<string, unknown>,
  review?: { supersedes: readonly number[] },
): void {
  const { bench, record, snapshot, author } = context;
  const issued = issueDeliveryControl(bench, {
    deliveryId: record.delivery_id,
    kind,
    ...(targetId !== undefined && { targetId }),
    body,
    author,
    ...(review !== undefined && { reviewAction: true, supersedes: review.supersedes }),
  });
  if (!issued.ok) {
    sendInvalidBody(
      res,
      issued.errors[0]?.split(":")[0] ?? "body",
      `The control fails the control contract: ${issued.errors.join("; ")}`,
    );
    return;
  }
  // The control adds no event, so the seq is unchanged: a `controls` frame is
  // one the client never skips, so it reads the snapshot again and shows the
  // control pending.
  broadcastDeliveryFrame(bench.projectId, bench.id, snapshot.seq, "controls");
  res.status(202).json(issued.control);
}

// The outstanding control of one kind that targets the decision, if any.
function waitingControl(bench: Bench, kind: DeliveryControlKind, decisionId: string) {
  return deliveryControlsOf(bench).find(
    (control) =>
      control.kind === kind && control.target_id === decisionId && isControlOutstanding(control),
  );
}

router.post(
  "/:projectId/benches/:id/delivery/decisions/:decisionId/answer",
  deliveryControlRateLimiter,
  async (req, res) => {
    const context = await decisionControlContext(req, res);
    if (!context) return;
    const { bench, decisionId, decision, option } = context;
    if (!isDecisionOpen(decision)) {
      res.status(409).json({
        error: `The decision ${decisionId} is ${decision.status} already`,
        code: "DECISION_NOT_OPEN",
        status: decision.status,
      });
      return;
    }
    if (decision.options.length > 0 && !decision.options.includes(option)) {
      sendInvalidBody(res, "option", `option must be one of the options of ${decisionId}`);
      return;
    }
    const waiting = waitingControl(bench, "decision-answer", decisionId);
    if (waiting !== undefined) {
      res.status(409).json({
        error: `An answer to ${decisionId} waits for the session to read it back`,
        code: "DECISION_ANSWER_PENDING",
        control_seq: waiting.control_seq,
      });
      return;
    }
    issueControl(res, context, "decision-answer", decisionId, { option });
  },
);

// ── Review actions on an agent decision (SB-FR-035) ──

function isAgentDecision(decision: DeliveryDecision): boolean {
  return decision.author === AGENT_AUTHOR;
}

// Answers 409 ALREADY_REVIEWED when a review outcome for the decision landed.
function sendIfReviewed(res: Response, decisionId: string, decision: DeliveryDecision): boolean {
  const status = decision.review?.status ?? "unreviewed";
  if (status === "unreviewed") return false;
  res.status(409).json({
    error: `The decision ${decisionId} is ${status} already`,
    code: "ALREADY_REVIEWED",
    status,
  });
  return true;
}

// Issues a review action (an accept or an overturn) on an agent decision. The
// same action again, with the same option for an overturn, answers with the
// pending control; another action supersedes the pending one. Once the tooling
// has read an action on the decision, nothing replaces it.
function issueReviewAction(
  res: Response,
  context: ControlContext,
  decisionId: string,
  kind: "review_accept" | "overturn",
  body: Record<string, unknown>,
): void {
  const actions = deliveryControlsOf(context.bench).filter(
    (control) =>
      isReviewControl(control) && control.target_id === decisionId && isControlOutstanding(control),
  );
  const delivered = actions.find((control) => control.status !== "pending");
  if (delivered !== undefined) {
    res.status(409).json({
      error: `The session has read a review action on ${decisionId} already`,
      code: "REVIEW_ACTION_DELIVERED",
      control_seq: delivered.control_seq,
    });
    return;
  }
  const same = actions.find(
    (control) =>
      control.kind === kind &&
      (kind === "review_accept" || (control.body as { option?: unknown }).option === body.option),
  );
  if (same !== undefined) {
    res.status(202).json(same);
    return;
  }
  issueControl(res, context, kind, decisionId, body, {
    supersedes: actions.map((control) => control.control_seq),
  });
}

router.post(
  "/:projectId/benches/:id/delivery/decisions/:decisionId/accept",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const summary = optionalBodyText(req, res, "summary");
    if (!summary.ok) return;
    const context = await controlContext(bench, res);
    if (!context) return;
    const target = pathDecision(req, res, context.snapshot);
    if (!target) return;
    const { decisionId, decision } = target;
    if (!isAgentDecision(decision)) {
      res.status(409).json({
        error: `The session asked the decision ${decisionId}: answer it instead`,
        code: "NOT_AGENT_DECISION",
      });
      return;
    }
    if (sendIfReviewed(res, decisionId, decision)) return;
    issueReviewAction(
      res,
      context,
      decisionId,
      "review_accept",
      summary.value === undefined ? {} : { summary: summary.value },
    );
  },
);

router.post(
  "/:projectId/benches/:id/delivery/decisions/:decisionId/overturn",
  deliveryControlRateLimiter,
  async (req, res) => {
    const context = await decisionControlContext(req, res);
    if (!context) return;
    const { bench, decisionId, decision, option } = context;
    if (isAgentDecision(decision)) {
      if (sendIfReviewed(res, decisionId, decision)) return;
      if (!decision.options.includes(option) || option === decision.chosen) {
        res.status(400).json({
          error: `option must be one of the options of ${decisionId} other than the one it chose`,
          code: "INVALID_OPTION",
          field: "option",
        });
        return;
      }
      issueReviewAction(res, context, decisionId, "overturn", { option });
      return;
    }
    if (!isDecisionDefaulted(decision)) {
      res.status(409).json({
        error: `The decision ${decisionId} is ${decision.status}, not defaulted`,
        code: "DECISION_NOT_DEFAULTED",
        status: decision.status,
      });
      return;
    }
    if (!decision.options.includes(option)) {
      sendInvalidBody(res, "option", `option must be one of the options of ${decisionId}`);
      return;
    }
    const applied = decision.chosen ?? decision.default;
    if (option === applied) {
      sendInvalidBody(
        res,
        "option",
        `option must be another option than ${applied}, which ${decisionId} applies already`,
      );
      return;
    }
    const waiting = waitingControl(bench, "overturn", decisionId);
    if (waiting !== undefined) {
      res.status(409).json({
        error: `An overturn of ${decisionId} waits for the session to read it back`,
        code: "DECISION_OVERTURN_PENDING",
        control_seq: waiting.control_seq,
      });
      return;
    }
    issueControl(res, context, "overturn", decisionId, { option });
  },
);

// ── The discussion thread of an agent decision (SB-FR-036) ──

// Whether the bench's main session, the terminal session core launched for
// the delivery, runs.
function isMainSessionLive(bench: Bench): boolean {
  const sessionId = bench.deliverySessionId;
  return sessionId !== undefined && getSession(sessionId)?.status === "live";
}

function sendThreadUnavailable(
  res: Response,
  reason: "no_review" | "no_session",
  error: string,
): void {
  res.status(409).json({ error, code: "THREAD_UNAVAILABLE", reason });
}

router.post(
  "/:projectId/benches/:id/delivery/decisions/:decisionId/thread",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const text: unknown = (req.body as { text?: unknown } | undefined)?.text;
    if (
      typeof text !== "string" ||
      text.trim().length === 0 ||
      text.length > DELIVERY_TEXT_MAX_LENGTH
    ) {
      res.status(400).json({
        error: `text must be a non-blank string of at most ${DELIVERY_TEXT_MAX_LENGTH} characters`,
        code: "INVALID_TEXT",
        field: "text",
      });
      return;
    }
    const context = await controlContext(bench, res);
    if (!context) return;
    const target = pathDecision(req, res, context.snapshot);
    if (!target) return;
    const { decisionId, decision } = target;
    if (!isAgentDecision(decision)) {
      res.status(409).json({
        error: `The session asked the decision ${decisionId}: answer it instead`,
        code: "NOT_AGENT_DECISION",
      });
      return;
    }
    if (context.snapshot.review.status !== "open") {
      sendThreadUnavailable(res, "no_review", "The thread opens at a review, and none is open");
      return;
    }
    if ((decision.review?.status ?? "unreviewed") !== "unreviewed") {
      sendThreadUnavailable(res, "no_review", `The review of ${decisionId} is over`);
      return;
    }
    if (!isMainSessionLive(bench)) {
      sendThreadUnavailable(
        res,
        "no_session",
        "The bench's main session does not run, so nothing reads the thread",
      );
      return;
    }
    // Volatile: held for the next controls read only, and never saved.
    issueControl(res, context, "thread_message", decisionId, { text });
  },
);

// ── Steering notes (SB-FR-016) ──

router.post(
  "/:projectId/benches/:id/delivery/steering",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const body = req.body as { text?: unknown; applies_at?: unknown } | undefined;
    const text = body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      sendInvalidBody(res, "text", "text must be a non-blank string");
      return;
    }
    const appliesAt = body?.applies_at;
    if (typeof appliesAt !== "string" || appliesAt.length === 0) {
      sendInvalidBody(
        res,
        "applies_at",
        "applies_at must name the unit boundary the note lands at",
      );
      return;
    }
    const context = await controlContext(bench, res);
    if (!context) return;
    // A note for every unit after the boundary it names: no unit list, and the
    // boundary kept as a loose key of the control body.
    issueControl(res, context, "steering-note", undefined, {
      note: text,
      unit_ids: [],
      applies_at: appliesAt,
    });
  },
);

router.post(
  "/:projectId/benches/:id/delivery/approve",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const reason = optionalBodyText(req, res, "reason");
    if (!reason.ok) return;
    // The gates' evaluated state decides the gating check, so the fold reads
    // the plan and the results as the snapshot read does; and the last
    // cross-check decides the blocking check.
    const context = await controlContext(bench, res, { verify: true, crossCheck: true });
    if (!context) return;
    // The folded record and the last cross-check decide, as the Approve
    // control does: nothing is approved in a state an approval is not open in,
    // while a blocking class of the cross-check is present (SB-FR-029), while a
    // gate is provisional (SB-FR-039), while a review is open (SB-FR-034), or
    // while a gating case is unmet (SB-FR-022).
    const refusal = selectApprovalRefusal(context.snapshot, context.disagreements);
    if (refusal !== null) {
      const { reason: error, ...rest } = refusal;
      res.status(409).json({ error, ...rest });
      return;
    }
    issueControl(res, context, "approval", undefined, reasonBody(reason.value));
  },
);

// ── Gate sittings (SB-FR-024, SB-FR-029) ──
//
// The route applies the lifecycle and cross-check refusals, then opens the
// sitting that a gate.reached prepared once its smoke check passed (SB-FR-023),
// or, with none prepared, has the gate pin service pin a detached worktree at
// the gate commit and record the sitting (see services/gate-pin.ts). Starting
// the sitting's session comes on top of it.

function sendGatePinError(res: Response, err: unknown): void {
  if (!(err instanceof GatePinError)) throw err;
  res.status(err.status).json({ error: err.message, code: err.code });
}

router.post(
  "/:projectId/benches/:id/delivery/sittings",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const gateId: unknown = (req.body as { gateId?: unknown } | undefined)?.gateId;
    if (typeof gateId !== "string" || gateId.length === 0) {
      sendInvalidBody(res, "gateId", "gateId must name a gate of the delivery");
      return;
    }
    const context = await controlContext(bench, res, { crossCheck: true });
    if (!context) return;
    if (ownValue(context.snapshot.gatesById, gateId) === undefined) {
      res.status(404).json({ error: `The delivery has no gate ${gateId}`, code: "GATE_NOT_FOUND" });
      return;
    }
    // An entry exempt for this gate (a verdict claimed over its unconfirmed
    // provisional marks) does not refuse the sitting that confirms them.
    const refusal = selectSittingRefusal(context.snapshot, context.disagreements, gateId);
    if (refusal !== null) {
      const { reason: error, ...rest } = refusal;
      res.status(409).json({ error, ...rest });
      return;
    }
    const open = bench.deliverySitting;
    if (open !== undefined) {
      if (open.gateId !== gateId) {
        res.status(409).json({
          error:
            (open.state ?? "open") === "open"
              ? `A sitting of gate ${open.gateId} is open already`
              : `A sitting of gate ${open.gateId} is being prepared`,
          code: "SITTING_OPEN",
          gateId: open.gateId,
        });
        return;
      }
      if ((open.state ?? "open") === "open") {
        // The same sitting again: it is open already.
        res.status(202).json(open);
        return;
      }
      // The sitting gate.reached prepared: it opens once its smoke check passed
      // (SB-FR-023), and is refused while the gate waits for its build.
      try {
        const sitting = await openPreparedSitting(bench, gateId);
        res.status(201).json(sitting);
      } catch (err) {
        sendGatePinError(res, err);
      }
      return;
    }
    const commit = gateCommitOf(context.snapshot, gateId);
    if (commit === undefined) {
      res.status(409).json({
        error: `The delivery record names no commit for gate ${gateId}`,
        code: "GATE_COMMIT_MISSING",
        gateId,
      });
      return;
    }
    let resultsSpecPath: string;
    try {
      resultsSpecPath = deliverySpecFolder(bench);
    } catch (err) {
      if (!(err instanceof UnsafePathError)) throw err;
      res.status(409).json({ error: err.message, code: "DELIVERY_INVALID" });
      return;
    }
    try {
      const sitting = await openGatePin(bench, { gateId, commit, resultsSpecPath });
      res.status(201).json(sitting);
    } catch (err) {
      sendGatePinError(res, err);
    }
  },
);

router.delete(
  "/:projectId/benches/:id/delivery/sittings/current",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    try {
      await closeGatePin(bench);
      res.status(204).end();
    } catch (err) {
      sendGatePinError(res, err);
    }
  },
);

function reasonBody(reason: string | undefined): Record<string, unknown> {
  return reason === undefined ? {} : { reason };
}

// Answers 409 WRONG_LIFECYCLE_STATE, naming the state, when the folded
// record's lifecycle state is not one the action is open in.
function sendIfWrongLifecycleState(
  res: Response,
  snapshot: DeliverySnapshot,
  action: DeliveryLifecycleAction,
): boolean {
  const availability = selectLifecycleAction(snapshot, action);
  if (availability.available) return false;
  res.status(409).json({
    error: availability.reason,
    code: "WRONG_LIFECYCLE_STATE",
    state: availability.state,
  });
  return true;
}

// Pause and wind-down (SB-FR-022): a delivery-wide control with an optional
// reason, issued once the lifecycle state allows it.
function lifecycleControlRoute(action: "pause" | "wind-down") {
  return async (req: Request, res: Response): Promise<void> => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const reason = optionalBodyText(req, res, "reason");
    if (!reason.ok) return;
    const context = await controlContext(bench, res);
    if (!context) return;
    if (sendIfWrongLifecycleState(res, context.snapshot, action)) return;
    issueControl(res, context, action, undefined, reasonBody(reason.value));
  };
}

router.post(
  "/:projectId/benches/:id/delivery/pause",
  deliveryControlRateLimiter,
  lifecycleControlRoute("pause"),
);

router.post(
  "/:projectId/benches/:id/delivery/wind-down",
  deliveryControlRateLimiter,
  lifecycleControlRoute("wind-down"),
);

// ── The role matrix (SB-FR-021) ──

router.put(
  "/:projectId/benches/:id/delivery/roles",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const body = req.body as { role?: unknown; tier?: unknown } | undefined;
    const role = body?.role;
    if (typeof role !== "string" || role.length === 0) {
      sendInvalidBody(res, "role", "role must name a role of the delivery");
      return;
    }
    const tier = body?.tier;
    if (typeof tier !== "string" || tier.trim().length === 0) {
      sendInvalidBody(res, "tier", "tier must be a non-blank string");
      return;
    }
    const context = await controlContext(bench, res);
    if (!context) return;
    if (ownValue(context.snapshot.roles, role) === undefined) {
      sendInvalidBody(res, "role", `role must name a role of the delivery, and ${role} is none`);
      return;
    }
    issueControl(res, context, "role-change", role, { tier });
  },
);

// ── The decision mode (SB-FR-032) ──

// The last outstanding mode switch of the delivery, if any.
function waitingModeSwitch(bench: Bench, deliveryId: string) {
  return deliveryControlsOf(bench)
    .filter(
      (control) =>
        control.kind === "mode_switch" &&
        control.delivery_id === deliveryId &&
        isControlOutstanding(control),
    )
    .at(-1);
}

router.put(
  "/:projectId/benches/:id/delivery/mode",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const mode: unknown = (req.body as { mode?: unknown } | undefined)?.mode;
    if (!isModeValue(mode)) {
      sendInvalidBody(res, "mode", "mode must be attended or auto");
      return;
    }
    const context = await controlContext(bench, res);
    if (!context) return;
    // No cross-check and no lifecycle state holds a switch back: only the mode
    // decides.
    const waiting = waitingModeSwitch(bench, context.record.delivery_id);
    if (waiting !== undefined && (waiting.body as { mode?: unknown }).mode === mode) {
      // The same switch is on its way already.
      res.status(202).json(waiting);
      return;
    }
    const inEffect = context.snapshot.mode;
    if (waiting === undefined && inEffect.value === mode && (inEffect.pending ?? null) === null) {
      res.status(409).json({
        error: `The delivery is in ${mode} mode already`,
        code: "MODE_UNCHANGED",
        mode,
      });
      return;
    }
    issueControl(res, context, "mode_switch", undefined, { mode });
  },
);

function sendLaunchFailed(res: Response, err: unknown): void {
  const reason = err instanceof Error && err.message ? err.message : String(err);
  res.status(502).json({
    error: `The delivery session did not start: ${reason}`,
    code: "DELIVERY_LAUNCH_FAILED",
  });
}

router.post(
  "/:projectId/benches/:id/delivery/launch",
  deliveryWriteRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    if (bench.deliveryBindMode !== "launch") {
      res.status(409).json({
        error: "An attached Spec Bench launches no delivery session of its own",
        code: "DELIVERY_NOT_LAUNCH_MODE",
      });
      return;
    }
    const loaded = loadBenchDeliveryRecord(bench);
    if (loaded.ok) {
      res.status(409).json({
        error: "The bench already has a delivery record: resume the delivery instead",
        code: "DELIVERY_RECORD_PRESENT",
      });
      return;
    }
    if (loaded.error.code !== "DELIVERY_RECORD_MISSING") {
      res.status(409).json(loaded.error);
      return;
    }
    const early = deliveryLaunchBlock(bench);
    if (early !== undefined) {
      sendLaunchBlocked(res, bench, early);
      return;
    }
    await benchManager.whenWorkspaceProvisioned(bench.projectId, bench.id);
    await whenDeliveryBound(bench.projectId, bench.id);
    try {
      const launched = await launchDeliverySession(bench);
      res.status(202).json({
        ...(launched.sessionId !== undefined && { sessionId: launched.sessionId }),
      });
    } catch (err) {
      if (err instanceof DeliveryLaunchBlockedError) {
        sendLaunchBlocked(res, bench, err.block);
        return;
      }
      sendLaunchFailed(res, err);
    }
  },
);

router.post(
  "/:projectId/benches/:id/delivery/resume",
  deliveryWriteRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const loaded = loadBenchDeliveryRecord(bench);
    if (!loaded.ok) {
      res.status(409).json(loaded.error);
      return;
    }
    // The folded lifecycle state, as the Resume control reads it (SB-FR-022).
    const snapshot = foldDelivery({
      record: loaded.record,
      events: deliveryEventsAfterRecord(
        bench.projectId,
        bench.id,
        loaded.record,
        benchDeliveryEventSpillPath(bench),
      ),
    });
    if (sendIfWrongLifecycleState(res, snapshot, "resume")) return;
    const state = snapshot.lifecycle.state;
    const early = deliveryLaunchBlock(bench);
    if (early !== undefined) {
      sendLaunchBlocked(res, bench, early, state);
      return;
    }
    // The create-time launch may still be on its way: wait for it, so its
    // session is recorded before the check that launchDeliverySession makes.
    await benchManager.whenWorkspaceProvisioned(bench.projectId, bench.id);
    await whenDeliveryBound(bench.projectId, bench.id);
    try {
      const launched = await launchDeliverySession(bench, { resume: loaded.record.delivery_id });
      res.status(202).json({
        resume: loaded.record.delivery_id,
        ...(launched.sessionId !== undefined && { sessionId: launched.sessionId }),
      });
    } catch (err) {
      if (err instanceof DeliveryLaunchBlockedError) {
        sendLaunchBlocked(res, bench, err.block, state);
        return;
      }
      sendLaunchFailed(res, err);
    }
  },
);

router.post(
  "/:projectId/benches/:id/delivery/attach",
  deliveryWriteRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    await whenDeliveryBound(bench.projectId, bench.id);
    try {
      const descriptor = handOutDeliveryToken(bench);
      // The body carries the plain token: nothing may keep a copy of it.
      res.set("Cache-Control", "no-store");
      res.status(201).json(descriptor);
    } catch (err) {
      if (err instanceof DeliveryLaunchBlockedError) {
        sendLaunchBlocked(res, bench, err.block);
        return;
      }
      throw err;
    }
  },
);

export default router;
