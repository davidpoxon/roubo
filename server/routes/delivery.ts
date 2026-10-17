// REST surface of a Spec Bench's delivery (SB-FR-002, SB-FR-003, SB-FR-009).
//
// Endpoints (mounted under /api/projects):
//   GET  /:projectId/benches/:id/delivery         -> 200 DeliverySnapshot
//                                                    404 not a Spec Bench
//                                                    409 DeliveryReadError: the record is
//                                                        missing, at an unknown major,
//                                                        missing a section
//                                                        (DELIVERY_NONCONFORMANT + section)
//                                                        or invalid (DELIVERY_INVALID + field)
//   POST /:projectId/benches/:id/delivery/events  -> 202 one event from the session,
//                                                    which presents its delivery token
//                                                    as a bearer token; 401 without it
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
// Only the events route checks the delivery token. Launch, resume and the attach
// handout are operator actions on the local API, which checks no caller, like
// the other bench routes. The handout's body carries the plain token, so it is
// sent with Cache-Control: no-store and nothing here logs it.
//
// The record is `.specifications/<slug>/delivery-observation.json` inside the
// bench workspace. It is read and validated on every request (see
// delivery-record-loader), so nothing a view shows comes from a record that no
// longer conforms.
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { Bench } from "@roubo/shared";
import { validateDeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { loadBenchDeliveryRecord } from "../lib/delivery-record-loader.js";
import { foldDeliverySnapshot } from "../lib/delivery-snapshot.js";
import * as benchManager from "../services/bench-manager.js";
import { verifyDeliveryToken } from "../services/delivery-token-registry.js";
import { appendDeliveryEvent, listDeliveryEvents } from "../services/delivery-event-store.js";
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
// js/missing-rate-limiting). A session posts an event per step, so the event
// limit is the wide one.
const deliveryReadRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const deliveryEventRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1200,
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

function bearerToken(req: Request): string | undefined {
  const header = req.get("authorization");
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
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
  const events = listDeliveryEvents(bench.projectId, bench.id, loaded.record.delivery_id);
  res.json(foldDeliverySnapshot({ record: loaded.record, events, now: Date.now() }));
});

router.post("/:projectId/benches/:id/delivery/events", deliveryEventRateLimiter, (req, res) => {
  const bench = specBenchOf(req, res);
  if (!bench) return;
  // The token is checked before the body is read, so a caller without it
  // learns nothing about the event shape.
  if (!verifyDeliveryToken(bench, bearerToken(req))) {
    res.status(401).json({ error: "A valid delivery token is required", code: "UNAUTHORIZED" });
    return;
  }
  const event = validateDeliveryEvent(req.body);
  if (!event.ok) {
    res.status(400).json({
      error: `Invalid delivery event: ${event.errors.join("; ")}`,
      code: "INVALID_EVENT",
      errors: event.errors,
    });
    return;
  }
  const added = appendDeliveryEvent(bench.projectId, bench.id, event.data);
  res.status(202).json({ seq: event.data.seq, duplicate: !added });
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
