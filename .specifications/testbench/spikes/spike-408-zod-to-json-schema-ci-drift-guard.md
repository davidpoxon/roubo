# Spike 408: Does z.toJSONSchema() produce publication-quality JSON Schema for the FR-019 targeting unions, and can a CI drift guard keep schema/ in lockstep with the zod source?

**Status:** Resolved · **Issue:** #408 · **Class:** both · **Resolves:** FR-019 schema-contract feasibility de-risking · **Implements:** FR-023, NFR-006, US-011 · **Verified by:** TC-056, TC-064 · **Produces:** shared/testbench-targeting-schema.ts, scripts/generate-schema.ts, schema/testbench-targeting.spike.schema.json, .github/workflows/pr-check.yml (schema-drift job) · **Gates:** #6, #7 · **Recommendation:** adopt

## Objective and method

Prove, before any real TestBench contract is authored (#6), that:

1. zod 4's `z.toJSONSchema()` emits publication-quality JSON Schema for the worst-case FR-019 shape: an OPTIONAL union over five distinct targeting strategies (CSS selector, ARIA role + accessible name, visible-text anchor, route/URL context, region), in its two real positions (per-step `target`, per-observation `observe`).
2. A `generate:schema` script plus a CI regenerate-and-`git diff --exit-code` guard can keep the published `schema/` output from drifting from the zod source.

Method: build the pipeline end to end against a small representative zod fixture (deliberately NOT the un-authored #6 contracts), generate the JSON Schema, inspect the output, then prove the drift guard both passes on a clean tree and fails on a hand-edit.

Run under Node 24.15.0 (the repo's `.nvmrc`; engines require >= 24.14.0). zod 4.4.3, prettier 3.8.3, tsx 4.21.0.

## Findings per acceptance criterion

### AC1: z.toJSONSchema() output is publication-quality (or a thin shim is identified)

**Verdict: publication-quality, with one one-key authoring rule (no post-processing shim needed).**

The fixture (`shared/testbench-targeting-schema.ts`) models each targeting strategy as a closed object discriminated on a literal `kind`, combined with `z.discriminatedUnion`. The generated `schema/testbench-targeting.spike.schema.json` is exactly what you would hand-author:

- **Optional fields are correct.** `target` and `observe` appear in `properties` but are absent from each carrier's `required` array. `.optional()` round-trips faithfully.
- **The union is a clean `oneOf`.** Each of the five branches is a self-contained object with its own `required`, `additionalProperties: false`, and a `const` discriminator on `kind`. No `anyOf` slop, no merged/duplicated property bags.
- **Constraints carry through.** `z.string().min(1)` becomes `minLength: 1`; `.strict()` becomes `additionalProperties: false`; `.describe()` becomes per-node `description`; `.meta({ title, description })` becomes top-level `title`/`description`.
- **Dialect.** Output is JSON Schema **draft 2020-12** (`$schema: https://json-schema.org/draft/2020-12/schema`). The existing hand-authored `schema/roubo-*.json` are **draft-07**. This is acceptable for the spike and is the expected zod-4 default; the real schemas (#6) will land on 2020-12 too. Noting the dialect delta so it is a conscious decision, not a surprise.

**The one authoring rule (NFR-005 `$id` versioning):** zod's `meta({ id })` registers the schema for internal `$ref`/`$defs` reuse but does **not** emit a top-level `$id`. To publish a versioned `$id`, pass the literal `$id` key through `meta({ $id: "...vX.Y.Z.json" })`. That single key is the entire "shim"; there is no output post-processing. The fixture uses a semver-versioned `$id` (`.../v0.1.0.json`) and the generated file carries it at the root.

### AC2: a generate:schema script writes JSON Schema into schema/

`scripts/generate-schema.ts` (run via `tsx`, the repo's TS runner) calls `z.toJSONSchema(schema, { target: "draft-2020-12" })` and writes `schema/testbench-targeting.spike.schema.json`. Wired as `npm run generate:schema`. tsx is pinned as an explicit devDependency (4.21.0, fixed, no `^`) so `npm ci` guarantees it in CI rather than relying on it being transitively present.

**Determinism finding (load-bearing for AC3):** raw `JSON.stringify(_, null, 2)` does NOT match prettier's formatting; prettier collapses short arrays (e.g. `"required": ["kind", "selector"]`) onto one line. A naive generator would therefore drift against `format:check` and, worse, against itself in CI. The generator resolves the repo's prettier config and formats its own output with `parser: "json"`, so the committed file is simultaneously (a) prettier-clean and (b) byte-for-byte reproducible by a re-run. Verified idempotent.

### AC3: a CI step regenerates and git-diffs the output, failing on drift

Added a `schema-drift` job to `.github/workflows/pr-check.yml`, modelled on the existing fail-on-difference jobs (the `lint` / `lint:em-dash` pattern): `npm ci` -> `npm run generate:schema` -> `git diff --exit-code -- schema/testbench-targeting.spike.schema.json`.

**Scope honoured:** the guard targets ONLY the spike artifact path. It does not gate on `schema/roubo-*.json`. Running the generator over the real authored schemas in production CI is #7 and explicitly out of scope.

### AC4: approach modelled on the existing format:check CI step

Clarification recorded: `format:check` is **not** actually wired into `pr-check.yml`; the `lint` job runs only `npm run lint` and `npm run lint:em-dash`. So the guard is modelled on the **fail-on-difference pattern** those jobs embody (regenerate/derive, then fail if the tree differs), not on a literal `format:check` job. The drift guard reuses that pattern via `git diff --exit-code`.

## Verification performed

- `npm run generate:schema` writes the schema; output inspected (see `schema/testbench-targeting.spike.schema.json`).
- `npx prettier --check schema/testbench-targeting.spike.schema.json` -> clean.
- Re-running the generator is idempotent (no diff).
- **Drift detection proven both ways:** on a clean tree `git diff --exit-code -- schema/testbench-targeting.spike.schema.json` exits 0; after a hand-edit to the committed schema it exits non-zero (guard fires); restoring the file returns it to clean.

## Recommendation

**Adopt.** `z.toJSONSchema()` is fit for purpose for the FR-019 unions with no bespoke post-processing beyond the `$id`-via-`meta` authoring rule. The generate + drift-guard pipeline is sound and ready to be extended (not rebuilt) over the real contracts. Carry these forward into #6/#7:

1. Author union members as `.strict()` objects discriminated on a literal and combine with `z.discriminatedUnion` to get clean `oneOf` branches.
2. Put the versioned `$id` on the schema via `meta({ $id: "...vX.Y.Z.json" })` (NFR-005); `meta({ id })` alone will not emit it.
3. The generator must format its output with the repo's prettier config, or the drift guard will fire on whitespace alone.
4. When #7 promotes this to the real schemas, extend the `artifacts` list in `scripts/generate-schema.ts` and widen the CI `git diff` path beyond the spike file.

## Next steps not taken here (out of scope)

- Authoring the real `test-cases.json` / `test-results.json` zod contracts (#6).
- Pointing the drift guard at the authored schemas in production CI (#7).
- The draft-07 -> draft 2020-12 migration of the existing `schema/roubo-*.json` (separate concern; not in FR-019's path).
