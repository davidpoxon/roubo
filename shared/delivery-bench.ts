// What a Spec Bench and its delivery session share (SB-FR-002, SB-FR-003,
// SB-FR-009): the launch descriptor the bench hands the session, the routes the
// descriptor names, and the read of a delivery record on load, with the named
// errors a nonconformant or invalid record gives.
//
// It also holds the frame the notification stream carries for an accepted batch
// of delivery events, and the named errors the event ingest gives (SB-FR-007).
//
// Agent-agnostic by construction (SB-NFR-001). The descriptor is data: two URLs,
// a token, an optional resume argument and an optional decision mode. It names
// no agent, no model and no command line; the agent launch executor decides how
// the data reaches the session it starts.

import {
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "./delivery-observation-contract";
import { classifyUnitStatus, type DeliverySnapshot } from "./delivery-reducer";
import type { BenchDeliverySitting, SpecBenchDecisionMode } from "./types";

// ── Routes ──
//
// The operator's delivery routes of a bench hang off one base path:
//
//   GET  <base>          the folded snapshot, or a named read error
//   GET  <base>/events   the accepted events above a seq, for one unit or all
//                        (DeliveryEventsResponse), or the same named read error
//   POST <base>/launch   launch a launch-mode bench's session again while it has no record
//   POST <base>/resume   launch the session again with the record's resume argument
//   POST <base>/decisions/<id>/answer
//                        answer a decision with a control in the bench's outbox
//   POST <base>/decisions/<id>/overturn
//                        overturn a defaulted decision's default the same way
//
// The delivery session's own routes sit beside the other hook endpoints, under
// /api/hooks, and name the bench in their query (`projectId`, `benchId`); the
// session presents its delivery token as a bearer token on each:
//
//   POST <events>        one event envelope or a batch of them (SB-FR-007)
//   GET <controls>       the control outbox the session reads, above `after`
//                        (SB-FR-014), held up to `wait` ms for the next
//                        control when none is there yet (SB-FR-041)
export const DELIVERY_EVENT_HOOK_PATH = "/api/hooks/delivery-event";
export const DELIVERY_CONTROLS_HOOK_PATH = "/api/hooks/delivery-controls";
// The longest `wait` a control read takes, in ms. It stays under Node's default
// request timeouts, so a held read never meets one.
export const DELIVERY_CONTROL_WAIT_MAX_MS = 25_000;

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
//
// `change: "controls"` is sent when the bench's control outbox changed with no
// new event, such as after a decision answer (SB-FR-014). Its seq is the
// current accepted seq, which the client may already hold, so the client never
// skips it and always reads the snapshot again.
export type DeliveryStreamChange = "snapshot" | "controls";

export interface DeliveryStreamFrame {
  type: "delivery";
  projectId: string;
  benchId: number;
  change: DeliveryStreamChange;
  seq: number;
}

// ── Spec summary (SB-FR-001) ──
//
// The body of GET /api/projects/:projectId/specbench/specs/:slug/summary: what
// the Set up Spec Bench dialog shows of a spec before the bench is created.
// `units` counts the spec's work units that deliver code (every kind but
// `verify`), and `gates` counts its verify gates, both from the spec's
// `work-units.json` in the project checkout. A spec with no `work-units.json`
// answers 0 and 0.
//
// `delivery` is present only when a conformant delivery record of the spec is
// committed at the commit that a bench created now would start its worktree
// from (the default branch or the checkout's HEAD, as the project's worktree
// source settings say): a delivery started elsewhere, the record an attached
// bench's worktree checks out and joins (SB-FR-003). A record that is only in
// the working tree of the checkout, or a local edit of a committed one, is not
// what the bench sees, so it is not what the summary names. It names the
// record's progress (its units done, of all its units) and its lifecycle state,
// read for the dialog only.
export interface SpecBenchSpecDelivery {
  deliveryId: string;
  lifecycleState: string;
  unitsDone: number;
  units: number;
}

/** The summary's `delivery` of a conformant record. */
export function summarizeSpecDelivery(record: DeliveryRecord): SpecBenchSpecDelivery {
  return {
    deliveryId: record.delivery_id,
    lifecycleState: record.lifecycle.state,
    unitsDone: record.units.filter((unit) => classifyUnitStatus(unit.status) === "done").length,
    units: record.units.length,
  };
}

export interface SpecBenchSpecSummary {
  slug: string;
  units: number;
  gates: number;
  delivery?: SpecBenchSpecDelivery;
}

// ── Snapshot read ──
//
// The body of GET <base>: the folded snapshot, with the bench's gate sitting
// beside it while the bench prepares or has one (SB-FR-023). `sitting.state`
// is `preparing` while the gate waits for its build, `ready` once the pinned
// build passed its smoke check and the operator is called, and `open` once the
// sitting opened; `sitting.smokeCheck` is the last check's verdict. The key is
// absent while the bench has no sitting. `sitting.fixUnitBlockers` lists the
// fix units filed for cases marked Not met (SB-FR-027), and `sitting.blocked`
// is true while any is listed: the gate reads blocked until each clears.
export type DeliverySnapshotResponse = DeliverySnapshot & {
  sitting?: Pick<
    BenchDeliverySitting,
    "gateId" | "state" | "commit" | "smokeCheck" | "fixUnitBlockers"
  > & { blocked?: boolean };
};

// ── Events read ──
//
// The body of GET <base>/events?after=<seq>&unit=<id>. `events` are the
// accepted events above `after` (absent: every accepted event above the
// record's `last_event_seq`), those of the unit named by `unit` when it is
// given (the envelope's `unit_id`), in seq order. Only the events above the
// record's `last_event_seq` are kept, so an `after` below it reads from there.
// `acceptedSeq` is the bench's accepted seq, the seq a later read goes on from.
// With `unit`, `folded` counts the unit's accepted events at or below the
// record's `last_event_seq`: the record carries them, so `events` leaves them
// out, and a unit with an empty list and a `folded` above 0 has events, all in
// the record (SB-FR-013). The server knows the events it accepted since it
// started, so after a restart the count can be 0 for a unit the record moved.
export interface DeliveryEventsResponse {
  events: DeliveryEvent[];
  acceptedSeq: number;
  folded?: number;
}

// ── Unit drill-in reads (SB-FR-013) ──
//
// The body of GET <base>/units/:unitId/diff: the pull-request diff of the
// unit's layer, as `git diff <base> <head>` in the bench workspace. `head` is
// the unit's `head`; `base` is the `head` of the unit below it in its stack, or
// the stack base (the merge base of the workspace's HEAD and the unit's head)
// for a unit at the stack's base or one whose lower layer has no head. Both are
// null, and `diff` empty, while the unit has no head. A diff over
// DELIVERY_DIFF_MAX_BYTES is cut there, and `truncated` says so. No GitHub call
// is made.
export interface DeliveryUnitDiffResponse {
  unit: string;
  base: string | null;
  head: string | null;
  diff: string;
  truncated: boolean;
}

export const DELIVERY_DIFF_MAX_BYTES = 1024 * 1024;

// The body of GET <base>/units/:unitId/transcript: what the bench's delivery
// session terminal wrote between the unit's first and last accepted event, cut
// from that terminal's scrollback by time. `from` and `to` are the `ts` of
// those two events (the record may already carry them), null while the server
// knows none; `sessionId` is the bench's delivery session, null when the bench
// recorded none or its terminal is gone.
// `lines` are the scrollback chunks as the terminal wrote them, escape
// sequences included; empty when there is no span or no session.
export interface DeliveryUnitTranscriptResponse {
  unit: string;
  sessionId: string | null;
  from: string | null;
  to: string | null;
  lines: string[];
}

// ── The delivery cross-check (SB-FR-028, SB-FR-030) ──
//
// The body of GET <base>/crosscheck: the disagreements of the last refresh of
// the bench's cross-check, when that refresh ran (`refreshedAt`, null before the
// first), and the source that could not be read on it. A refresh that cannot
// read GitHub keeps the disagreements that GitHub settles from the refresh
// before it and names GitHub in `sourceError`; the next refresh that reads
// GitHub clears it.

// A claimed or observed value of a disagreement: a word, a list (a stack's
// branch order), a small record (a head claimed on more than one side), or null.
export type DeliveryCrossCheckValue =
  string | null | readonly string[] | Readonly<Record<string, string | null>>;

// One disagreement between the record and the source of truth of its class.
export interface DeliveryCrossCheckDisagreement {
  class: string;
  blocking: boolean;
  unitId?: string;
  stack?: string;
  caseId?: string;
  blocksAbove?: string[];
  // The gate whose own sitting the entry does not block: set on a
  // gate-state-differs entry for a gate that claims a verdict over an
  // unconfirmed provisional mark.
  sittingExempt?: string;
  claimed: DeliveryCrossCheckValue;
  observed: DeliveryCrossCheckValue;
  source: string;
}

export interface DeliveryCrossCheckSourceError {
  source: "github";
  message: string;
}

export interface DeliveryCrossCheckResponse {
  disagreements: DeliveryCrossCheckDisagreement[];
  refreshedAt: string | null;
  sourceError: DeliveryCrossCheckSourceError | null;
}

// The most events a bench keeps in memory above its record's `last_event_seq`,
// and so the most one batch may carry. The event route reads its body with a
// parser of its own, whose limit is set so a full batch fits; the server's
// global 210 KB body limit would refuse one.
export const DELIVERY_EVENT_LOG_MAX = 1_000;

// When a batch would take the in-memory log over DELIVERY_EVENT_LOG_MAX, the
// oldest events leave memory DELIVERY_EVENT_SPILL_CHUNK at a time for the spill
// file: an append-only JSON Lines file beside the record in the bench
// workspace, so it goes with the workspace like the record does. Whatever reads
// the event log reads the spill file as well as memory, in seq order.
export const DELIVERY_EVENT_SPILL_CHUNK = 500;
export const DELIVERY_EVENT_SPILL_FILE = "delivery-events.jsonl";

// Beside the spill file, the span of each unit's accepted events (the ts of its
// first and last event and its seqs), so a unit's drill-in can still cut its
// transcript and count its folded events after a server restart (SB-FR-013).
// It goes with the workspace like the record does.
export const DELIVERY_UNIT_SPANS_FILE = "delivery-unit-spans.json";

// ── Ingest errors ──
//
//   INVALID_EVENT           an event fails the envelope schema, or names another
//                           delivery (`field` names the field, `index` the event)
//   STALE_SEQ               every event of the batch is at or below the accepted seq
//   SEQ_GAP                 an event skips a seq: the next one must be acceptedSeq + 1
//   EVENT_LOG_SPILL_FAILED  the log was full and its oldest events could not be
//                           written to the spill file, so the batch was not applied
export const DELIVERY_INGEST_ERROR_CODES = [
  "INVALID_EVENT",
  "STALE_SEQ",
  "SEQ_GAP",
  "EVENT_LOG_SPILL_FAILED",
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
// the record's `delivery_id`. `decisionMode` is present only on a fresh launch
// of a launch-mode bench: the decision mode chosen at set-up (SB-FR-031). A
// resume carries none, because the record holds the mode.
export interface DeliveryLaunchDescriptor {
  eventUrl: string;
  controlsUrl: string;
  token: string;
  resume?: string;
  decisionMode?: SpecBenchDecisionMode;
}

export interface DeliveryLaunchInput {
  // The server origin the session reaches the bench at, e.g. http://localhost:3335.
  origin: string;
  projectId: string;
  benchId: number;
  // The plain token, minted for this launch. Only its hash is stored.
  token: string;
  resume?: string;
  decisionMode?: SpecBenchDecisionMode;
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
    ...(input.decisionMode !== undefined && { decisionMode: input.decisionMode }),
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
