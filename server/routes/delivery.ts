// REST surface of a Spec Bench's delivery (SB-FR-002, SB-FR-003, SB-FR-008,
// SB-FR-009, SB-FR-013).
//
// Endpoints (mounted under /api/projects):
//   GET  /:projectId/benches/:id/delivery         -> 200 DeliverySnapshot: the record,
//                                                    with the accepted events above its
//                                                    last_event_seq (in memory and in the
//                                                    spill file) folded over it, with the
//                                                    spec's plan and results in the
//                                                    workspace for gate state and progress
//                                                    404 not a Spec Bench
//                                                    409 DeliveryReadError: the record is
//                                                        missing, at an unknown major,
//                                                        missing a section
//                                                        (DELIVERY_NONCONFORMANT + section)
//                                                        or invalid (DELIVERY_INVALID + field)
//   GET  /:projectId/benches/:id/delivery/events?after=<seq>&unit=<id>
//                                                 -> 200 DeliveryEventsResponse
//                                                    {events, acceptedSeq}: the accepted
//                                                    events above `after` (absent: every
//                                                    one above the record's
//                                                    last_event_seq, in memory and in the
//                                                    spill file), only those whose
//                                                    envelope unit_id is `unit` when it
//                                                    is given, in seq order; acceptedSeq
//                                                    is the bench's accepted seq
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
import type { DeliveryEventsResponse } from "@roubo/shared/delivery-bench";
import { deliveryAcceptedSeq, deliveryEventsAfterRecord } from "../services/delivery-event-log.js";
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
  // The plan and results give the gates their state and the progress its cases
  // met and requirements covered (SB-FR-011).
  const verify = loadBenchDeliveryVerifyInputs(bench);
  res.json(foldDeliverySnapshot({ record: loaded.record, events, ...verify, now: Date.now() }));
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
  res.json(body);
});

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
