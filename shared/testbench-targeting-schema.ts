// Spike #408: representative zod source for the FR-019 guided-execution
// targeting-field unions, used to prove z.toJSONSchema() output quality and to
// drive the generate:schema script + CI drift guard.
//
// This is a SPIKE fixture, not the authored TestBench contract. The real
// test-cases.json / test-results.json schemas are authored under #6; this file
// exists only to exercise the worst-case shape (an optional union over five
// distinct targeting strategies) through the generation pipeline so the
// pipeline itself can be committed and gated before the contracts land.
//
// FR-019 reserves OPTIONAL, additive targeting fields:
//   - a per-step `target`
//   - a per-observation `observe`
// each expressible as one of: CSS selector, ARIA role + accessible name,
// visible-text anchor, route/URL context, or region. Both fields share the
// same union shape, so a single `TargetSchema` models both.

import { z } from "zod";

// Versioned identifier (NFR-005: semver-style versioning lives on the schema's
// $id). Spike finding: zod's `meta({ id })` registers the schema for internal
// $ref/$defs reuse but does NOT emit a top-level `$id`. To publish `$id` into
// the output you pass the literal `$id` key through `meta()` (see the root
// schema below). That single key is the only post-processing needed; no shim.
export const TESTBENCH_TARGETING_SCHEMA_ID =
  "https://roubo.dev/schema/testbench-targeting.spike/v0.1.0.json";

// ── Targeting strategies ──
// Each member is a closed object discriminated by a literal `kind`, so the
// union round-trips through JSON Schema as a clean oneOf with per-branch
// required/additionalProperties.

const CssSelectorTarget = z
  .object({
    kind: z.literal("css"),
    // A CSS selector string, e.g. `#submit` or `button.primary`.
    selector: z.string().min(1),
  })
  .strict()
  .describe("Target an element by CSS selector.");

const AriaRoleTarget = z
  .object({
    kind: z.literal("role"),
    // An ARIA role, e.g. `button`, `link`, `heading`.
    role: z.string().min(1),
    // The accessible name the element is matched on.
    name: z.string().min(1),
  })
  .strict()
  .describe("Target an element by ARIA role and accessible name.");

const VisibleTextTarget = z
  .object({
    kind: z.literal("text"),
    // Visible text content used as an anchor.
    text: z.string().min(1),
    // When true, match the whole visible string rather than a substring.
    exact: z.boolean().optional(),
  })
  .strict()
  .describe("Target an element by a visible-text anchor.");

const RouteTarget = z
  .object({
    kind: z.literal("route"),
    // A route or URL-path context, e.g. `/settings/testbench`.
    path: z.string().min(1),
  })
  .strict()
  .describe("Scope targeting to a route/URL context.");

const RegionTarget = z
  .object({
    kind: z.literal("region"),
    // A named landmark/region, e.g. `main`, `navigation`, or a labelled section.
    region: z.string().min(1),
  })
  .strict()
  .describe("Scope targeting to a named page region or landmark.");

// The shared optional targeting union. Discriminated on `kind` so consumers get
// an exhaustive, type-safe switch and JSON Schema emits a clean oneOf.
export const TargetSchema = z
  .discriminatedUnion("kind", [
    CssSelectorTarget,
    AriaRoleTarget,
    VisibleTextTarget,
    RouteTarget,
    RegionTarget,
  ])
  .describe(
    "An optional, additive guided-execution targeting selector (FR-019): one of a CSS selector, ARIA role + accessible name, visible-text anchor, route/URL context, or named region.",
  );
export type Target = z.infer<typeof TargetSchema>;

// ── Representative step / observation carriers ──
// These show the union in its real position: an OPTIONAL field on a step and on
// an observation. Everything else is intentionally minimal; this is a fixture.

const Step = z
  .object({
    // Human-readable instruction for the guided-execution step.
    instruction: z.string().min(1),
    // FR-019: optional per-step target. Additive; absence means "unspecified".
    target: TargetSchema.optional(),
  })
  .strict();

const Observation = z
  .object({
    // What the tester should look for.
    prompt: z.string().min(1),
    // FR-019: optional per-observation observe target. Same union as `target`.
    observe: TargetSchema.optional(),
  })
  .strict();

// Root schema tying the fixture together and carrying the versioned $id.
export const TestbenchTargetingSpikeSchema = z
  .object({
    steps: z.array(Step),
    observations: z.array(Observation),
  })
  .strict()
  .meta({
    $id: TESTBENCH_TARGETING_SCHEMA_ID,
    title: "TestBench Targeting (spike)",
    description:
      "Spike #408 fixture proving z.toJSONSchema() output quality for the FR-019 optional per-step `target` and per-observation `observe` targeting unions. Not the authored TestBench contract (#6).",
  });
export type TestbenchTargetingSpike = z.infer<typeof TestbenchTargetingSpikeSchema>;
