// State recipe contract: the compile-time source of truth (in `shared/`) for
// the published, versioned shape of one per-case STATE RECIPE (SB-FR-025,
// SB-US-009). A recipe says how to put a checkout of one unit's commit into the
// state a test case observes: what the replay requires, the steps that build the
// state, and the observation the operator makes at the end. The recipe replayer
// validates a recipe against this contract before it runs a step.
//
// Mirrors delivery-observation-contract.ts: a zod source schema, the inferred
// type, a runtime validator returning field-named errors, and a versioned `$id`
// constant. The generate script renders it into schema/ and the CI drift guard
// keeps the committed JSON equal to the zod source.
//
// Agent-agnostic by construction (SB-NFR-001): a recipe names a case, a unit and
// a commit, and its steps are shell-neutral verbs, never a vendor, a model or a
// tool.
//
// Compatibility posture (SB-NFR-007), as the observation contract: every object
// is `.loose()`, so a later minor version adds a field to a step or to the
// observation without a major bump. The step `kind` is a CLOSED discriminator:
// the replayer runs a step by its kind, so a kind it does not know is rejected,
// with the step's index in the error. A new kind is an additive change that
// bumps the minor, which scripts/contract-compatibility.ts classifies against
// the committed baseline under shared/__fixtures__/contract-baselines/.

import { z } from "zod";

// ── Versioned schema identifier ──

export const STATE_RECIPE_SCHEMA_ID = "https://roubo.dev/schema/state-recipe/v1.0.0.json";
export const STATE_RECIPE_SCHEMA_VERSION = "1.0.0";

// ── Shared scalars ──

// A non-empty identifier: a case id, a unit id, a requirement name.
const IdSchema = z.string().min(1);
// A non-empty string: a path, a command line, a URL.
const TextSchema = z.string().min(1);
// A step's time budget in whole milliseconds; the replayer fails the step when
// it runs past it. Absent means the replayer's own default.
const TimeoutMsSchema = z.number().int().positive();

// ── steps[] ──
//
// The four step kinds of 1.0.0. The operator chose richer step fields at 1.0.0
// rather than the least a replayer needs: a command step carries a time budget
// and the exit code it expects, an http step a time budget and the status it
// expects, and a copy-file step an overwrite policy. Every added field is
// optional, so a recipe that spells only the required fields still validates,
// and every object is loose so a later version can add a field (a header map,
// a retry count) as a minor bump. Field names are camelCase, as the recipe root
// spells `caseId` and `unitId`. A path is relative to the checkout unless
// absolute.
export const STATE_RECIPE_STEP_KINDS = ["command", "copy-file", "http", "open-url"] as const;
export type StateRecipeStepKind = (typeof STATE_RECIPE_STEP_KINDS)[number];

// Run one command line in the checkout, or in `cwd` under it. The step passes
// when the command exits with `expectedExitCode` (0 when absent) within
// `timeoutMs`.
export const CommandStepSchema = z
  .object({
    kind: z.literal("command"),
    command: TextSchema,
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: TimeoutMsSchema.optional(),
    expectedExitCode: z.number().int().min(0).max(255).optional(),
  })
  .loose();
export type CommandStep = z.infer<typeof CommandStepSchema>;

// What a copy-file step does when `to` already exists: `overwrite` replaces it
// (the default when absent), `create-only` fails the step. A closed enum, as
// `kind` is; a new policy is an additive change that bumps the minor.
export const COPY_FILE_MODES = ["overwrite", "create-only"] as const;
export const CopyFileModeSchema = z.enum(COPY_FILE_MODES);
export type CopyFileMode = z.infer<typeof CopyFileModeSchema>;

// Copy one file from `from` to `to`, under the overwrite policy `mode` names.
export const CopyFileStepSchema = z
  .object({
    kind: z.literal("copy-file"),
    from: TextSchema,
    to: TextSchema,
    mode: CopyFileModeSchema.optional(),
  })
  .loose();
export type CopyFileStep = z.infer<typeof CopyFileStepSchema>;

// Send one HTTP request. `method` is an open string, as HTTP's own method
// registry is. `body` is text; a JSON body is serialised by the producer. The
// step passes when the response carries `expectedStatus` (any 2xx when absent)
// within `timeoutMs`.
export const HttpStepSchema = z
  .object({
    kind: z.literal("http"),
    method: TextSchema,
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    timeoutMs: TimeoutMsSchema.optional(),
    expectedStatus: z.number().int().min(100).max(599).optional(),
  })
  .loose();
export type HttpStep = z.infer<typeof HttpStepSchema>;

// Open one URL for the operator to look at.
export const OpenUrlStepSchema = z
  .object({
    kind: z.literal("open-url"),
    url: z.url(),
  })
  .loose();
export type OpenUrlStep = z.infer<typeof OpenUrlStepSchema>;

const UNKNOWN_STEP_KIND_MESSAGE = `unknown step kind: expected one of ${STATE_RECIPE_STEP_KINDS.join(", ")}`;

export const StateRecipeStepSchema = z.discriminatedUnion(
  "kind",
  [CommandStepSchema, CopyFileStepSchema, HttpStepSchema, OpenUrlStepSchema],
  // zod reports an unmatched discriminator at the step's `kind` path, so the
  // field-named error reads `steps.<index>.kind: unknown step kind: ...`.
  { error: UNKNOWN_STEP_KIND_MESSAGE },
);
export type StateRecipeStep = z.infer<typeof StateRecipeStepSchema>;

// ── observation ──
//
// What the operator looks at once the steps have run: a sentence, and where to
// look. The operator chose a structured object at 1.0.0: `description` is the
// sentence, and `url` (a page to open), `path` (a file in the checkout) and
// `selector` (an element on the page, in CSS selector form) say where to look.
// Each location is optional, so a recipe gives the ones that apply.
export const StateRecipeObservationSchema = z
  .object({
    description: TextSchema,
    url: z.url().optional(),
    path: TextSchema.optional(),
    selector: TextSchema.optional(),
  })
  .loose();
export type StateRecipeObservation = z.infer<typeof StateRecipeObservationSchema>;

// ── The state recipe ──
//
// `$schema` is the literal STATE_RECIPE_SCHEMA_ID and `schemaVersion` the
// matching literal, as every published contract in shared/ does. `caseId` and
// `unitId` are camelCase as the test-cases contract spells its ids. `requires`
// names what the host needs before replay (a runtime, a service, a tool), as
// open words the replayer checks; empty means nothing beyond the checkout.
export const StateRecipeSchema = z
  .object({
    $schema: z.literal(STATE_RECIPE_SCHEMA_ID),
    schemaVersion: z.literal(STATE_RECIPE_SCHEMA_VERSION),
    caseId: IdSchema,
    unitId: IdSchema,
    // The commit the recipe replays at: the unit's head when it was recorded.
    commit: TextSchema,
    requires: z.array(IdSchema),
    steps: z.array(StateRecipeStepSchema),
    observation: StateRecipeObservationSchema,
  })
  .loose()
  // Pass the literal `$id` key through `.meta()` so `z.toJSONSchema()` emits a
  // top-level `$id` carrying the versioned identifier.
  .meta({
    $id: STATE_RECIPE_SCHEMA_ID,
    title: "State recipe",
    description:
      "How to put a checkout of one unit's commit into the state one test case observes (SB-FR-025): requirements, ordered steps of a known kind, and the observation to make.",
  });
export type StateRecipe = z.infer<typeof StateRecipeSchema>;

// ── Runtime validator ──
//
// Wraps `safeParse` (never throws) and returns a discriminated result, as
// validateDeliveryEvent does. On failure each zod issue becomes a
// `path: message` string keyed by the field that failed, so a step of an
// unknown kind reads `steps.<index>.kind: unknown step kind: ...`.

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function zodIssuesToFieldErrors(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateStateRecipe(raw: unknown): ValidationResult<StateRecipe> {
  const parsed = StateRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
