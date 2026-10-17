// The delivery session's endpoints, mounted under /api/hooks beside the other
// hook endpoints (SB-FR-007, SB-FR-008, SB-NFR-001).
//
//   POST /delivery-event?projectId=<id>&benchId=<n>
//     body: one delivery event envelope, or a JSON array of them (a batch)
//     -> 202 { acceptedSeq }: the batch is appended to the bench's event log,
//            and a delivery frame goes out on GET /api/notifications/stream
//        401 UNAUTHORIZED: no bearer token, or not the current token of the
//            bench the query names (another bench's token included). Also when
//            the query names no Spec Bench, so a caller without a token learns
//            nothing about which benches exist
//        400 INVALID_EVENT: an event fails the envelope schema (`field` names
//            the field, `index` the event), names another delivery, or the
//            batch is empty or over DELIVERY_EVENT_LOG_MAX events
//        400 STALE_SEQ: every event is at or below the accepted seq, or a seq
//            repeats within the batch (`field` is `seq`)
//        400 SEQ_GAP: an event skips a seq (`expected`, `got`)
//        409 a DeliveryReadError: the record is there but cannot be read, so
//            the accepted seq cannot be seeded from it
//        429 EVENT_LOG_FULL: the bench holds as many events above the record
//            as it keeps
//     Every refusal applies nothing. Events at or below the accepted seq in a
//     batch that also carries newer ones are dropped and the rest accepted.
//
// GET /delivery-controls lands on this router with the control outbox.
//
// Nothing here is agent-specific: the session is whatever the launch executor
// started, and it presents the token its launch descriptor carried.
import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import type { Bench } from "@roubo/shared";
import { DELIVERY_EVENT_LOG_MAX } from "@roubo/shared/delivery-bench";
import {
  validateDeliveryEvent,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";
import { loadBenchDeliveryRecord } from "../lib/delivery-record-loader.js";
import * as benchManager from "../services/bench-manager.js";
import { verifyDeliveryToken } from "../services/delivery-token-registry.js";
import { ingestDeliveryEvents } from "../services/delivery-event-log.js";
import { broadcastDeliveryFrame } from "../services/sse.js";

const router = Router();

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

router.post("/delivery-event", deliveryEventRateLimiter, (req, res) => {
  const bench = queriedSpecBench(req);
  // The token is checked before the body is read, so a caller without it
  // learns nothing about the event shape.
  if (bench === undefined || !verifyDeliveryToken(bench, bearerToken(req))) {
    res.status(401).json({ error: "A valid delivery token is required", code: "UNAUTHORIZED" });
    return;
  }

  const body: unknown = req.body;
  const raw: unknown[] = Array.isArray(body) ? body : [body];
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
  const result = ingestDeliveryEvents(
    bench.projectId,
    bench.id,
    loaded.ok ? loaded.record : undefined,
    batch,
  );
  if (!result.ok) {
    if (result.status === 429) res.set("Retry-After", "1");
    res.status(result.status).json(result.error);
    return;
  }
  broadcastDeliveryFrame(bench.projectId, bench.id, result.acceptedSeq);
  res.status(202).json({ acceptedSeq: result.acceptedSeq });
});

export default router;
