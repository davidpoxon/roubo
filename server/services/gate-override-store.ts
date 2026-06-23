// Per-project store for the Roubo-owned gate-overrides document (#703, FR-002,
// US-007). The operator's batch merge / split regroupings are persisted here, in
// `~/.roubo/gate-overrides/<projectId>.json`, NOT in roubo.yaml and NOT in the
// externally-authored work-units.json (Roubo never writes that file). The store
// is the only writer; gate-overrides.ts applies the document as a pure transform
// over the loaded verify units at read time.
//
// Path-safety (NFR-001): the projectId is constrained to PROJECT_ID_RE and the
// resolved file is re-confined under the gate-overrides directory before any fs
// call (the same containment-barrier shape CodeQL's js/path-injection suite
// recognises, mirroring integration-overrides.ts).

import fs from "node:fs";
import path from "node:path";
import {
  validateGateOverrides,
  emptyGateOverrides,
  type GateOverridesFile,
} from "@roubo/shared/gate-overrides-contract";
import { atomicWrite, getRouboDir } from "./state.js";
import { PROJECT_ID_RE, assertSafeIdentifier } from "../lib/safe-path.js";

export class GateOverrideStoreError extends Error {
  constructor(
    message: string,
    public code: "INVALID_PROJECT_ID" | "PARSE" | "SCHEMA",
    public errors?: string[],
  ) {
    super(message);
    this.name = "GateOverrideStoreError";
  }
}

const GATE_OVERRIDES_DIR_NAME = "gate-overrides";

function getGateOverridesDir(): string {
  return path.join(getRouboDir(), GATE_OVERRIDES_DIR_NAME);
}

// Resolve the per-project override file path, rejecting any projectId that is
// not a plain identifier or that escapes the gate-overrides directory.
function resolveOverridePath(projectId: string): string {
  assertSafeIdentifier(projectId, PROJECT_ID_RE, "projectId");
  // Defence-in-depth: strip any path components and re-confine. Combined with
  // the regex above the value reaching path.resolve cannot contain separators
  // or traversal segments. This is the shape CodeQL's js/path-injection
  // sanitizer recognises.
  const safeId = path.basename(projectId);
  if (safeId !== projectId) {
    throw new GateOverrideStoreError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  const dir = getGateOverridesDir();
  const filePath = path.resolve(dir, `${safeId}.json`);
  if (!filePath.startsWith(dir + path.sep)) {
    throw new GateOverrideStoreError(`Invalid projectId: ${projectId}`, "INVALID_PROJECT_ID");
  }
  return filePath;
}

// Load the project's override document. Returns an empty (valid) document when
// no file exists yet: a project with no regroupings is the normal state, not an
// error. A present-but-corrupt file is surfaced (PARSE / SCHEMA), never silently
// treated as empty, which would drop the operator's recorded regroupings.
export function loadOverrides(projectId: string): GateOverridesFile {
  const filePath = resolveOverridePath(projectId);
  if (!fs.existsSync(filePath)) {
    return emptyGateOverrides();
  }

  const content = fs.readFileSync(filePath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new GateOverrideStoreError(
      `Failed to parse ${filePath}: ${(e as Error).message}`,
      "PARSE",
    );
  }

  const result = validateGateOverrides(raw);
  if (!result.ok) {
    throw new GateOverrideStoreError(
      `Invalid gate overrides at ${filePath}: ${result.errors.join("; ")}`,
      "SCHEMA",
      result.errors,
    );
  }
  return result.data;
}

// Persist the project's override document, re-validating before write so a
// malformed document can never land on disk.
export function saveOverrides(projectId: string, overrides: GateOverridesFile): void {
  const result = validateGateOverrides(overrides);
  if (!result.ok) {
    throw new GateOverrideStoreError(
      `Refusing to save invalid gate overrides: ${result.errors.join("; ")}`,
      "SCHEMA",
      result.errors,
    );
  }
  const filePath = resolveOverridePath(projectId);
  fs.mkdirSync(getGateOverridesDir(), { recursive: true });
  atomicWrite(filePath, `${JSON.stringify(result.data, null, 2)}\n`);
}

// Best-effort delete of the per-project override file (the reset endpoint).
// Missing files are not an error: callers want "after this, no override exists".
export function removeOverrides(projectId: string): void {
  const filePath = resolveOverridePath(projectId);
  fs.rmSync(filePath, { force: true });
}
