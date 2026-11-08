// REST surface of a Spec Bench's delivery (SB-FR-002, SB-FR-003, SB-FR-008,
// SB-FR-009, SB-FR-013, SB-FR-014, SB-FR-015, SB-FR-034).
//
// Endpoints (mounted under /api/projects):
//   GET  /:projectId/benches/:id/delivery         -> 200 DeliverySnapshot: the record,
//                                                    with the accepted events above its
//                                                    last_event_seq (in memory and in the
//                                                    spill file) folded over it, with the
//                                                    spec's plan, results and lifecycle in
//                                                    the workspace for gate state and
//                                                    progress
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
//                                                    the record's resume argument
//                                                    409 DELIVERY_SESSION_LIVE: the session
//                                                        the bench launched still runs or is
//                                                        starting
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
//   POST /:projectId/benches/:id/delivery/approve
//        body {reason?}                         -> 202 DeliveryOutboxControl: an
//                                                    approval control of the delivery,
//                                                    with no target, issued as an answer
//                                                    is
//                                                    400 INVALID_BODY + field: `reason`
//                                                        is given and not a string
//                                                    409 REVIEW_OPEN: the folded record's
//                                                        review status is `open`
//                                                        (`unreviewed` lists the decisions
//                                                        it waits on); the Approve control
//                                                        reads the same selector
//                                                    404 and 409 as the snapshot read
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
  loadBenchDeliveryRecord,
  loadBenchDeliveryVerifyInputs,
} from "../lib/delivery-record-loader.js";
import { foldDeliverySnapshot } from "../lib/delivery-snapshot.js";
import * as benchManager from "../services/bench-manager.js";
import {
  DELIVERY_DIFF_MAX_BYTES,
  type DeliveryEventsResponse,
  type DeliveryUnitDiffResponse,
  type DeliveryUnitTranscriptResponse,
} from "@roubo/shared/delivery-bench";
import type {
  DeliveryDecision,
  DeliveryEvent,
  DeliveryRecord,
  DeliveryUnit,
} from "@roubo/shared/delivery-observation-contract";
import type { Author } from "@roubo/shared/testbench-contracts";
import type { DeliveryControlKind } from "@roubo/shared/delivery-control-contract";
import {
  foldDelivery,
  isDecisionDefaulted,
  isDecisionOpen,
  ownValue,
  type DeliverySnapshot,
} from "@roubo/shared/delivery-reducer";
import { selectApprovalAvailability } from "@roubo/shared/delivery-selectors";
import {
  deliveryAcceptedSeq,
  deliveryEventsAfterRecord,
  deliveryUnitEventSpan,
} from "../services/delivery-event-log.js";
import { runCommand } from "../services/exec.js";
import { resolveGitIdentity } from "../services/git-helpers.js";
import {
  deliveryControlsOf,
  isControlOutstanding,
  issueDeliveryControl,
} from "../services/delivery-control-outbox.js";
import { broadcastDeliveryFrame } from "../services/sse.js";
import { getSessionScrollback } from "../services/terminal.js";
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
function sendLaunchBlocked(res: Response, bench: Bench, block: DeliveryLaunchBlock): void {
  if (block === "session_live") {
    res.status(409).json({
      error: "The delivery session of this bench is still running",
      code: "DELIVERY_SESSION_LIVE",
      ...(bench.deliverySessionId !== undefined && { sessionId: bench.deliverySessionId }),
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
  res.json(
    foldDeliverySnapshot({
      record: loaded.record,
      events,
      ...verify,
      controls: deliveryControlsOf(bench),
      now: Date.now(),
    }),
  );
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
}

interface DecisionControlContext extends ControlContext {
  decisionId: string;
  decision: DeliveryDecision;
  option: string;
}

// The operator's identity and the folded delivery of the bench; or the answer
// already sent when the record cannot be read.
async function controlContext(bench: Bench, res: Response): Promise<ControlContext | undefined> {
  // The operator Roubo knows: the git identity of the bench workspace, in the
  // results writer's Author shape. Resolved before the checks, so nothing
  // awaits between the checks and the issue.
  const identity = await resolveGitIdentity(bench.workspacePath);
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
  const snapshot = foldDelivery({ record: loaded.record, events });
  return {
    bench,
    record: loaded.record,
    snapshot,
    author:
      identity.isSentinel === true
        ? { name: identity.name, email: identity.email, isSentinel: true }
        : { name: identity.name, email: identity.email },
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
// contract.
function issueControl(
  res: Response,
  context: ControlContext,
  kind: DeliveryControlKind,
  targetId: string | undefined,
  body: Record<string, unknown>,
): void {
  const { bench, record, snapshot, author } = context;
  const issued = issueDeliveryControl(bench, {
    deliveryId: record.delivery_id,
    kind,
    ...(targetId !== undefined && { targetId }),
    body,
    author,
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

router.post(
  "/:projectId/benches/:id/delivery/decisions/:decisionId/overturn",
  deliveryControlRateLimiter,
  async (req, res) => {
    const context = await decisionControlContext(req, res);
    if (!context) return;
    const { bench, decisionId, decision, option } = context;
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

router.post(
  "/:projectId/benches/:id/delivery/approve",
  deliveryControlRateLimiter,
  async (req, res) => {
    const bench = specBenchOf(req, res);
    if (!bench) return;
    const reason = optionalBodyText(req, res, "reason");
    if (!reason.ok) return;
    const context = await controlContext(bench, res);
    if (!context) return;
    // The folded review decides, as the Approve control does: nothing is
    // approved while a review is open (SB-FR-034).
    const approval = selectApprovalAvailability(context.snapshot);
    if (!approval.available) {
      res.status(409).json({
        error: approval.reason,
        code: "REVIEW_OPEN",
        unreviewed: context.snapshot.review.unreviewed,
      });
      return;
    }
    issueControl(
      res,
      context,
      "approval",
      undefined,
      reason.value === undefined ? {} : { reason: reason.value },
    );
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
    const early = deliveryLaunchBlock(bench);
    if (early !== undefined) {
      sendLaunchBlocked(res, bench, early);
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
        sendLaunchBlocked(res, bench, err.block);
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
