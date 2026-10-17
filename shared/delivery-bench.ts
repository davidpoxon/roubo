// What a Spec Bench and its delivery session share (SB-FR-002, SB-FR-003,
// SB-FR-009): the launch descriptor the bench hands the session, the routes the
// descriptor names, and the read of a delivery record on load, with the named
// errors a nonconformant or invalid record gives.
//
// It also holds the frame the notification stream carries for an accepted batch
// of delivery events, and the named errors the event ingest gives (SB-FR-007).
//
// Agent-agnostic by construction (SB-NFR-001). The descriptor is data: two URLs,
// a token and an optional resume argument. It names no agent, no model and no
// command line; the agent launch executor decides how the data reaches the
// session it starts.

import {
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryRecord,
} from "./delivery-observation-contract";

// ── Routes ──
//
// The operator's delivery routes of a bench hang off one base path:
//
//   GET  <base>          the folded snapshot, or a named read error
//   POST <base>/launch   launch a launch-mode bench's session again while it has no record
//   POST <base>/resume   launch the session again with the record's resume argument
//
// The delivery session's own routes sit beside the other hook endpoints, under
// /api/hooks, and name the bench in their query (`projectId`, `benchId`); the
// session presents its delivery token as a bearer token on each:
//
//   POST <events>        one event envelope or a batch of them (SB-FR-007)
//   <controls>           the control outbox the session reads; its route comes
//                        with the control outbox, the descriptor names it now
export const DELIVERY_EVENT_HOOK_PATH = "/api/hooks/delivery-event";
export const DELIVERY_CONTROLS_HOOK_PATH = "/api/hooks/delivery-controls";

export interface DeliveryRoutePaths {
  base: string;
  events: string;
  controls: string;
  launch: string;
  resume: string;
}

export function deliveryRoutePaths(projectId: string, benchId: number): DeliveryRoutePaths {
  const base = `/api/projects/${encodeURIComponent(projectId)}/benches/${benchId}/delivery`;
  const bench = new URLSearchParams({ projectId, benchId: String(benchId) }).toString();
  return {
    base,
    events: `${DELIVERY_EVENT_HOOK_PATH}?${bench}`,
    controls: `${DELIVERY_CONTROLS_HOOK_PATH}?${bench}`,
    launch: `${base}/launch`,
    resume: `${base}/resume`,
  };
}

// ── Stream frame ──
//
// The frame GET /api/notifications/stream carries each time the server accepts
// a batch of a bench's delivery events. `seq` is the accepted seq after the
// batch. The frame carries no event: `change: "snapshot"` tells the client to
// read the snapshot again, and a frame whose seq the client already holds is
// one it can skip.
export interface DeliveryStreamFrame {
  type: "delivery";
  projectId: string;
  benchId: number;
  change: "snapshot";
  seq: number;
}

// The most events a bench keeps in memory above its record's `last_event_seq`,
// and so the most one batch may carry.
export const DELIVERY_EVENT_LOG_MAX = 1_000;

// ── Ingest errors ──
//
//   INVALID_EVENT    an event fails the envelope schema, or names another
//                    delivery (`field` names the field, `index` the event)
//   STALE_SEQ        every event of the batch is at or below the accepted seq
//   SEQ_GAP          an event skips a seq: the next one must be acceptedSeq + 1
//   EVENT_LOG_FULL   the bench holds DELIVERY_EVENT_LOG_MAX events the record
//                    has not caught up with yet
export const DELIVERY_INGEST_ERROR_CODES = [
  "INVALID_EVENT",
  "STALE_SEQ",
  "SEQ_GAP",
  "EVENT_LOG_FULL",
] as const;
export type DeliveryIngestErrorCode = (typeof DELIVERY_INGEST_ERROR_CODES)[number];

export interface DeliveryIngestError {
  code: DeliveryIngestErrorCode;
  error: string;
  field?: string;
  index?: number;
  errors?: string[];
  acceptedSeq?: number;
  expected?: number;
  got?: number;
}

// ── Launch descriptor ──
//
// The data the main delivery session starts with. `resume` is present only when
// the session continues a delivery the bench already holds a record for: it is
// the record's `delivery_id`.
export interface DeliveryLaunchDescriptor {
  eventUrl: string;
  controlsUrl: string;
  token: string;
  resume?: string;
}

export interface DeliveryLaunchInput {
  // The server origin the session reaches the bench at, e.g. http://localhost:3335.
  origin: string;
  projectId: string;
  benchId: number;
  // The plain token, minted for this launch. Only its hash is stored.
  token: string;
  resume?: string;
}

// Builds the descriptor. Each optional field is copied only when the input
// carries it, so a field the set-up dialog adds later joins the same way and a
// descriptor without it carries no key for it at all.
export function buildDeliveryLaunchDescriptor(
  input: DeliveryLaunchInput,
): DeliveryLaunchDescriptor {
  const origin = input.origin.replace(/\/+$/, "");
  const paths = deliveryRoutePaths(input.projectId, input.benchId);
  return {
    eventUrl: `${origin}${paths.events}`,
    controlsUrl: `${origin}${paths.controls}`,
    token: input.token,
    ...(input.resume !== undefined && { resume: input.resume }),
  };
}

// ── Record file ──

// The record's file name inside the spec folder `.specifications/<slug>/` of the
// bench workspace.
export const DELIVERY_RECORD_FILE = "delivery-observation.json";

// The required sections of a record, in the order SB-FR-005 and SB-FR-040 name
// them. A record that lacks one is nonconformant, and the error names the first
// missing one.
export const DELIVERY_RECORD_SECTIONS = [
  "mode",
  "review",
  "stack",
  "units",
  "decisions",
  "steering",
  "budget",
  "roles",
  "health",
  "drift",
  "seams",
  "lifecycle",
] as const;
export type DeliveryRecordSection = (typeof DELIVERY_RECORD_SECTIONS)[number];

// ── Read errors ──
//
//   DELIVERY_RECORD_MISSING    no record in the workspace's spec folder yet
//   DELIVERY_VERSION_MISMATCH  the record is at a contract major this reader does not know
//   DELIVERY_NONCONFORMANT     a required section is missing (`section` names it)
//   DELIVERY_INVALID           a field fails the record schema (`field` names the first)
export const DELIVERY_READ_ERROR_CODES = [
  "DELIVERY_RECORD_MISSING",
  "DELIVERY_VERSION_MISMATCH",
  "DELIVERY_NONCONFORMANT",
  "DELIVERY_INVALID",
] as const;
export type DeliveryReadErrorCode = (typeof DELIVERY_READ_ERROR_CODES)[number];

export interface DeliveryReadError {
  code: DeliveryReadErrorCode;
  error: string;
  // DELIVERY_NONCONFORMANT: the first missing section, and every missing one.
  section?: string;
  sections?: string[];
  // DELIVERY_INVALID: the path of the first failing field, and every error.
  field?: string;
  errors?: string[];
  // DELIVERY_VERSION_MISMATCH: the version the record carries, and the one read.
  found?: string;
  supported?: string;
}

export function isDeliveryReadError(value: unknown): value is DeliveryReadError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  const codes: readonly string[] = DELIVERY_READ_ERROR_CODES;
  return typeof code === "string" && codes.includes(code);
}

export type DeliveryRecordCheck =
  { ok: true; record: DeliveryRecord } | { ok: false; error: DeliveryReadError };

const SUPPORTED_MAJOR = DELIVERY_RECORD_SCHEMA_VERSION.split(".")[0];

function majorOf(version: string): string | undefined {
  return /^(\d+)\.\d+\.\d+/.exec(version)?.[1];
}

function schemaIdMajor(id: string): string | undefined {
  return /\/delivery-record\/v(\d+)\.\d+\.\d+\.json$/.exec(id)?.[1];
}

function versionMismatch(found: string): DeliveryRecordCheck {
  return {
    ok: false,
    error: {
      code: "DELIVERY_VERSION_MISMATCH",
      error: `The delivery record is at contract version ${found}, and this bench reads major version ${SUPPORTED_MAJOR} (${DELIVERY_RECORD_SCHEMA_VERSION})`,
      found,
      supported: DELIVERY_RECORD_SCHEMA_VERSION,
    },
  };
}

// Checks a parsed record, in this order: the contract major, then the required
// sections, then the full schema. A record at a later minor of the same major
// is read as the version this bench knows: every object of the schema keeps an
// unknown key, so the additions a minor brings pass through (SB-NFR-007).
export function checkDeliveryRecord(raw: unknown): DeliveryRecordCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_INVALID",
        error: "The delivery record must be a JSON object",
        errors: ["the record must be a JSON object"],
      },
    };
  }
  const document = raw as Record<string, unknown>;
  const version = document.schemaVersion;
  const schemaId = document.$schema;
  let sameMajor = false;
  if (typeof version === "string" && majorOf(version) !== undefined) {
    if (majorOf(version) !== SUPPORTED_MAJOR) return versionMismatch(version);
    sameMajor = true;
  }
  if (typeof schemaId === "string") {
    const idMajor = schemaIdMajor(schemaId);
    if (idMajor !== undefined && idMajor !== SUPPORTED_MAJOR) {
      return versionMismatch(typeof version === "string" ? version : schemaId);
    }
  }

  const missing = DELIVERY_RECORD_SECTIONS.filter((section) => !Object.hasOwn(document, section));
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_NONCONFORMANT",
        error: `The delivery record is missing its ${missing[0]} section`,
        section: missing[0],
        sections: missing,
      },
    };
  }

  const candidate =
    sameMajor && typeof schemaId === "string" && schemaIdMajor(schemaId) === SUPPORTED_MAJOR
      ? {
          ...document,
          $schema: DELIVERY_RECORD_SCHEMA_ID,
          schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
        }
      : document;
  const result = validateDeliveryRecord(candidate);
  if (!result.ok) {
    const first = result.errors[0] ?? "the record does not match the schema";
    const colon = first.indexOf(":");
    const field = colon > 0 ? first.slice(0, colon) : undefined;
    return {
      ok: false,
      error: {
        code: "DELIVERY_INVALID",
        error: field
          ? `The delivery record has an invalid ${field}: ${first.slice(colon + 1).trim()}`
          : `The delivery record is invalid: ${first}`,
        ...(field !== undefined && { field }),
        errors: result.errors,
      },
    };
  }
  // A record of a later minor comes back at the version this bench reads, which
  // is the version its type describes.
  return { ok: true, record: result.data };
}
