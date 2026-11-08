// The delivery session's endpoints, mounted under /api/hooks beside the other
// hook endpoints (SB-FR-007, SB-FR-008, SB-NFR-001).
//
//   POST /delivery-event?projectId=<id>&benchId=<n>
//     body: one delivery event envelope, or a batch { events: [envelope, ...] }
//     -> 202 { acceptedSeq }: the batch is appended to the bench's event log,
//            and a delivery frame goes out on GET /api/notifications/stream.
//            A unit.changed whose status reads as jammed raises the bench's
//            delivery-jam notification for the unit, and one whose status does
//            not dismisses it (see services/delivery-jam.ts). A
//            decision.raised raises the bench's delivery-decision
//            notification for the decision, one per decision id, and a
//            decision.answered or decision.overturned dismisses it. A
//            decision.decided raises none. A batch with a review.opened
//            raises one delivery-decision notification for the review call,
//            read from the folded delivery after the batch: its count is the
//            decision cards of the open review and its key names the
//            delivery, the event's trigger and the oldest of those cards by
//            decided_at. The event's own list is not read. The metadata
//            carries the count and no session text (see
//            services/delivery-decision.ts)
//        401 UNAUTHORIZED: no bearer token, or not the current token of the
//            bench the query names (another bench's token included). Also when
//            the query names no Spec Bench, so a caller without a token learns
//            nothing about which benches exist
//        400 INVALID_EVENT: an event fails the envelope schema (`field` names
//            the field, `index` the event), names another delivery, or the
//            batch is not a wrapper with an `events` array (a bare array
//            included), or is empty or over DELIVERY_EVENT_LOG_MAX events
//        413 PAYLOAD_TOO_LARGE: the body is over DELIVERY_EVENT_BODY_LIMIT
//        400 STALE_SEQ: every event is at or below the accepted seq, or a seq
//            repeats within the batch (`field` is `seq`)
//        400 SEQ_GAP: an event skips a seq (`expected`, `got`)
//        409 a DeliveryReadError: the record is there but cannot be read, so
//            the accepted seq cannot be seeded from it
//        500 EVENT_LOG_SPILL_FAILED: the batch would take the in-memory log
//            over DELIVERY_EVENT_LOG_MAX, and its oldest events could not be
//            written to the bench's spill file
//     Every refusal applies nothing. Events at or below the accepted seq in a
//     batch that also carries newer ones are dropped and the rest accepted.
//     A full log never refuses a batch: its oldest events move to the spill
//     file beside the record in the bench workspace (see
//     services/delivery-event-log.ts), and the batch is accepted.
//
// The route reads its body with its own JSON parser, deliveryEventBodyParser,
// which the server mounts ahead of the global 210 KB parser: a full batch of
// DELIVERY_EVENT_LOG_MAX events is larger than 210 KB, so under the global
// limit it would never reach the route.
//
//   GET /delivery-controls?projectId=<id>&benchId=<n>&after=<control_seq>&wait=<ms>
//     -> 200 DeliveryControlReadReply {controls, latestSeq}: the controls of
//            the bench's outbox above `after` (absent: 0), durable and
//            volatile, in control_seq order whatever their kind, each with its
//            status, and the highest control_seq the bench has issued (0
//            before any). A volatile control is served by one read only. A
//            control stays `pending` until an event reads it back (see POST
//            above), but for a review action on an agent decision (a
//            `review_accept`, or an `overturn` of an agent decision, which
//            carries `reviewAction: true`): the read that serves it marks it
//            `delivered`. A `superseded` control is never served. With no
//            control to serve above `after` (none, or only superseded ones)
//            and a `wait` above 0 (absent: 0), the read is held until a
//            control is issued, then answers with it, or until the wait ends,
//            then answers with an empty list (SB-FR-041). A server shutdown answers a held read
//            with an empty list too
//        200 DeliveryControlReadSuperseded {controls: [], superseded: true}: a
//            second held read for the same bench ended this one. A bench holds
//            one read at a time; a reader that goes away drops its hold
//        401 UNAUTHORIZED: as POST /delivery-event, checked before the query,
//            and again when a held read ends: a revoked or replaced token
//            ends it with 401
//        400 INVALID_QUERY + field: `after` is not a non-negative integer
//        400 INVALID_WAIT + field: `wait` is not an integer from 0 to
//            DELIVERY_CONTROL_WAIT_MAX_MS (25,000)
//     The query is open to more keys: a key this route does not know is
//     ignored.
//
// An accepted event that reads a control back (one whose payload names the
// control's control_seq, a decision.answered for the decision an answer
// control targets, a decision.overturned for the decision an overturn
// control targets, or a review.outcome for the decision a review_accept
// (`accepted`) or an overturn (`overturned`) targets) marks that control
// `applied` in the outbox before the 202. A review.outcome with the other
// outcome marks an outstanding review action on that decision `superseded`
// instead, so no later read serves it (see services/delivery-control-outbox.ts).
// An accepted mode.changed sets the bench's decision mode to the mode it
// applied, and when that mode changed a bench-decision-mode event goes out on
// GET /api/notifications/stream, so the bench card names it (SB-FR-032).
//
// Nothing here is agent-specific: the session is whatever the launch executor
// started, and it presents the token its launch descriptor carried.
import express, { Router, type Request, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import type { Bench } from "@roubo/shared";
import { DELIVERY_CONTROL_WAIT_MAX_MS, DELIVERY_EVENT_LOG_MAX } from "@roubo/shared/delivery-bench";
import type { DeliveryControlReadSuperseded } from "@roubo/shared/delivery-control-contract";
import {
  validateDeliveryEvent,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import {
  benchDeliveryEventSpillPath,
  loadBenchDeliveryRecord,
} from "../lib/delivery-record-loader.js";
import * as benchManager from "../services/bench-manager.js";
import { verifyDeliveryToken } from "../services/delivery-token-registry.js";
import {
  applyDeliveryControlReadBacks,
  applyDeliveryModeReadBack,
  deliveryControlLatestSeq,
  hasServableDeliveryControl,
  readDeliveryControls,
  waitForDeliveryControl,
} from "../services/delivery-control-outbox.js";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { deliveryEventsAfterRecord, ingestDeliveryEvents } from "../services/delivery-event-log.js";
import { applyDeliveryDecisionNotifications } from "../services/delivery-decision.js";
import { applyDeliveryJamNotifications } from "../services/delivery-jam.js";
import { broadcastBenchDecisionMode, broadcastDeliveryFrame } from "../services/sse.js";

const router = Router();

// The body limit of POST /delivery-event. An envelope's text fields are each
// bounded, and a realistic envelope is a few hundred bytes, so 2 MB carries a
// full batch of DELIVERY_EVENT_LOG_MAX events with room to spare.
export const DELIVERY_EVENT_BODY_LIMIT = "2mb";

const deliveryEventJson = express.json({ limit: DELIVERY_EVENT_BODY_LIMIT });

function isEntityTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "entity.too.large"
  );
}

// The JSON parser of POST /delivery-event. The server mounts it on that path
// before its global parser, which then finds the body read and skips it. A
// body over the limit gets a JSON 413 rather than the default error page.
export const deliveryEventBodyParser: RequestHandler = (req, res, next) => {
  void deliveryEventJson(req, res, (error?: unknown) => {
    if (isEntityTooLarge(error)) {
      res.status(413).json({
        error: `A delivery event body holds at most ${DELIVERY_EVENT_BODY_LIMIT}`,
        code: "PAYLOAD_TOO_LARGE",
      });
      return;
    }
    next(error);
  });
};

// A session posts an event per step, so the limit is wide.
const deliveryEventRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// The Spec Bench the query names, or undefined.
function queriedSpecBench(req: Request): Bench | undefined {
  const projectId = queryString(req.query.projectId);
  const benchText = queryString(req.query.benchId);
  if (projectId === undefined || benchText === undefined || !/^\d+$/.test(benchText)) {
    return undefined;
  }
  const bench = benchManager.getBench(projectId, Number(benchText));
  if (!bench || bench.variant !== "specbench" || !bench.focusedSpecPath) return undefined;
  return bench;
}

function bearerToken(req: Request): string | undefined {
  const header = req.get("authorization");
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

// The path of the field a validator error names: the part before its first
// colon, when there is one.
function fieldOf(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const colon = error.indexOf(":");
  return colon > 0 ? error.slice(0, colon) : undefined;
}

// The events a body carries: the `events` array of a batch wrapper, or the one
// envelope a body that is not a wrapper holds. Undefined for a bare array, or a
// wrapper whose `events` is not an array.
function batchOf(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return undefined;
  if (typeof body === "object" && body !== null && "events" in body) {
    const events = (body as { events: unknown }).events;
    return Array.isArray(events) ? events : undefined;
  }
  return [body];
}

router.post("/delivery-event", deliveryEventRateLimiter, (req, res) => {
  const bench = queriedSpecBench(req);
  // The token is checked before the body is read, so a caller without it
  // learns nothing about the event shape.
  if (bench === undefined || !verifyDeliveryToken(bench, bearerToken(req))) {
    res.status(401).json({ error: "A valid delivery token is required", code: "UNAUTHORIZED" });
    return;
  }

  const raw = batchOf(req.body);
  if (raw === undefined) {
    res.status(400).json({
      error: "A batch is an object whose events field is an array of event envelopes",
      code: "INVALID_EVENT",
      field: "events",
    });
    return;
  }
  if (raw.length === 0 || raw.length > DELIVERY_EVENT_LOG_MAX) {
    res.status(400).json({
      error: `A batch holds from 1 to ${DELIVERY_EVENT_LOG_MAX} events, and this one holds ${raw.length}`,
      code: "INVALID_EVENT",
      field: "events",
    });
    return;
  }
  const batch: DeliveryEvent[] = [];
  for (const [index, item] of raw.entries()) {
    const event = validateDeliveryEvent(item);
    if (!event.ok) {
      const field = fieldOf(event.errors[0]);
      res.status(400).json({
        error: `Invalid delivery event at index ${index}: ${event.errors.join("; ")}`,
        code: "INVALID_EVENT",
        ...(field !== undefined && { field }),
        index,
        errors: event.errors,
      });
      return;
    }
    batch.push(event.data);
  }

  // The record seeds the accepted seq. While the bench has none yet, the
  // sequence starts at 1; a record that is there but unreadable gives nothing
  // to check the batch against, so the batch waits for it.
  const loaded = loadBenchDeliveryRecord(bench);
  if (!loaded.ok && loaded.error.code !== "DELIVERY_RECORD_MISSING") {
    res.status(409).json(loaded.error);
    return;
  }
  // An unsafe spec folder fails the record load above with DELIVERY_INVALID,
  // so the spill path resolves here.
  const result = ingestDeliveryEvents(
    bench.projectId,
    bench.id,
    loaded.ok ? loaded.record : undefined,
    batch,
    benchDeliveryEventSpillPath(bench),
  );
  if (!result.ok) {
    res.status(result.status).json(result.error);
    return;
  }
  // A unit.changed that jams a unit raises its delivery-jam notification, and
  // one that moves it on dismisses it (SB-FR-019).
  applyDeliveryJamNotifications(bench, result.events);
  // A decision.raised raises its delivery-decision notification, once per
  // decision, and an answer or an overturn that lands dismisses it (SB-FR-014).
  // A review.opened raises one for the review call (SB-FR-034), counted and
  // keyed from the folded delivery after this batch.
  const record = loaded.ok ? loaded.record : undefined;
  applyDeliveryDecisionNotifications(bench, result.events, () => {
    if (record === undefined) return undefined;
    const accepted = deliveryEventsAfterRecord(
      bench.projectId,
      bench.id,
      record,
      benchDeliveryEventSpillPath(bench),
    );
    return foldDelivery({ record, events: accepted });
  });
  // An event that reads a control back marks it applied (SB-FR-014).
  applyDeliveryControlReadBacks(bench, result.events);
  // A mode.changed moves the bench's mode in effect, which the bench card
  // names (SB-FR-032). The record load above has already moved it to the mode
  // of the folded record, so a mode.changed that the record carries, and that
  // this batch therefore skips, has moved it too.
  const mode = applyDeliveryModeReadBack(bench, result.events);
  broadcastDeliveryFrame(bench.projectId, bench.id, result.acceptedSeq);
  if (mode !== undefined) broadcastBenchDecisionMode(bench.projectId, bench.id, mode);
  res.status(202).json({ acceptedSeq: result.acceptedSeq });
});

// The tooling reads the outbox after each step, so the limit is as wide as the
// event route's.
const deliveryControlsRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.get("/delivery-controls", deliveryControlsRateLimiter, (req, res) => {
  const bench = queriedSpecBench(req);
  // The token is checked before the query, so a caller without it learns
  // nothing about the outbox.
  if (bench === undefined || !verifyDeliveryToken(bench, bearerToken(req))) {
    res.status(401).json({ error: "A valid delivery token is required", code: "UNAUTHORIZED" });
    return;
  }
  const rawAfter = req.query.after;
  let after = 0;
  if (rawAfter !== undefined) {
    after = typeof rawAfter === "string" && /^\d+$/.test(rawAfter) ? Number(rawAfter) : Number.NaN;
    if (!Number.isSafeInteger(after)) {
      res.status(400).json({
        error: "after must be a non-negative integer control_seq",
        code: "INVALID_QUERY",
        field: "after",
      });
      return;
    }
  }
  const rawWait = req.query.wait;
  let wait = 0;
  if (rawWait !== undefined) {
    wait = typeof rawWait === "string" && /^\d+$/.test(rawWait) ? Number(rawWait) : Number.NaN;
    if (!Number.isSafeInteger(wait) || wait > DELIVERY_CONTROL_WAIT_MAX_MS) {
      res.status(400).json({
        error: `wait must be an integer from 0 to ${DELIVERY_CONTROL_WAIT_MAX_MS} ms`,
        code: "INVALID_WAIT",
        field: "wait",
      });
      return;
    }
  }

  // A control to serve is above `after`, or the read does not wait: answer
  // now. A superseded control is never served, so it does not end the wait.
  if (wait === 0 || hasServableDeliveryControl(bench, after)) {
    res.json(readDeliveryControls(bench, after));
    return;
  }

  // Hold the read until a control is issued or the wait ends (SB-FR-041).
  const held = waitForDeliveryControl(bench, wait);
  res.on("close", () => {
    if (!res.writableEnded) held.cancel();
  });
  void held.done.then((reason) => {
    if (reason === "closed" || res.writableEnded) return;
    if (reason === "revoked" || !verifyDeliveryToken(bench, bearerToken(req))) {
      res.status(401).json({ error: "A valid delivery token is required", code: "UNAUTHORIZED" });
      return;
    }
    if (reason === "superseded") {
      res.json({ controls: [], superseded: true } satisfies DeliveryControlReadSuperseded);
      return;
    }
    if (reason === "shutdown") {
      res.json({ controls: [], latestSeq: deliveryControlLatestSeq(bench) });
      return;
    }
    res.json(readDeliveryControls(bench, after));
  });
});

export default router;
