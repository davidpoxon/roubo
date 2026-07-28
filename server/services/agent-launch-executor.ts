import fs from "node:fs";
import path from "node:path";
import {
  AgentLaunchDescriptorSchema,
  SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION,
  type AgentLaunchDescriptor,
  type AgentPosture,
  type WorkspaceWriteSpec,
  type WriteOp,
} from "@roubo/shared/agent-launch-descriptor-schema";
import { assertRealpathWithin, resolveWithin, UnsafePathError } from "../lib/safe-path.js";
import { atomicWrite } from "./state.js";

// AgentLaunchExecutor (issue #507, AP-FR-001, AP-NFR-001).
//
// The core-side half of the agent contract. An agent plugin returns a
// declarative AgentLaunchDescriptor from `translateLaunch`; this module
// validates it against the shared Zod schema and executes the one privileged
// thing it can express, workspace file writes, entirely core-side.
//
// This is the mechanism behind AP-TC-014 S003-O02 and the issue's "workspace
// file writes are only expressible as declarative descriptors that core
// validates and executes" criterion. A plugin cannot reach a bench workspace
// itself: the plugin-fs broker allowlist grants only its own plugin dir plus
// statically declared manifest paths, never a bench workspace, and an agent
// plugin is granted no component broker surface at all (see the spawn seam in
// plugin-manager.ts, which withholds host.process.start/run/stop/status/logs,
// host.docker.* and host.ports.* for every non-component kind; the v1
// host.process.spawn every kind gets is a separate handler, capped by the
// executables the manifest declares). So the only route
// from a plugin to a workspace file is a WorkspaceWriteSpec resolved here under
// the two containment barriers every synchronous write sink in this repo pairs:
// the lexical `resolveWithin(workspacePath, relPath)` plus the on-disk
// `assertRealpathWithin`, which together reject every escape.
//
// Modelled on lifecycle-engine.runDescriptor: validate FIRST, before any
// filesystem call, and surface a legible message on rejection.

export class AgentDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDescriptorError";
  }
}

/**
 * Validate a raw value returned by `translateLaunch` against the shared schema.
 * Throws `AgentDescriptorError` on any shape or version mismatch; nothing has
 * touched the filesystem at that point.
 */
export function validateDescriptor(raw: unknown): AgentLaunchDescriptor {
  const parsed = AgentLaunchDescriptorSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  if (raw && typeof raw === "object" && "schemaVersion" in raw) {
    const supplied = (raw as { schemaVersion: unknown }).schemaVersion;
    if (supplied !== SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION) {
      throw new AgentDescriptorError(
        `Unsupported agent launch descriptor schemaVersion ${JSON.stringify(
          supplied,
        )}; this host supports schemaVersion ${SUPPORTED_AGENT_LAUNCH_SCHEMA_VERSION}`,
      );
    }
  }
  throw new AgentDescriptorError(`Invalid AgentLaunchDescriptor: ${parsed.error.message}`);
}

/**
 * Every workspace write a descriptor declares, in execution order: the plain
 * `capabilities.workspaceWrites`, then the selected posture's writes, then the
 * notification wiring's carrier write when the agent uses the `http-hook` shape
 * (its hook registration lives in a settings file). Capability absence is
 * first-class, so a descriptor declaring none yields an empty list and no file
 * is touched.
 */
export function collectWorkspaceWrites(
  descriptor: AgentLaunchDescriptor,
  opts: { posture?: AgentPosture } = {},
): WorkspaceWriteSpec[] {
  const capabilities = descriptor.capabilities;
  if (!capabilities) return [];

  const writes: WorkspaceWriteSpec[] = [...(capabilities.workspaceWrites ?? [])];

  if (opts.posture) {
    const binding = capabilities.permissions?.postures[opts.posture];
    if (binding?.workspaceWrites) writes.push(...binding.workspaceWrites);
  }

  if (capabilities.notification?.kind === "http-hook") {
    writes.push(capabilities.notification.carrier.workspaceWrite);
  }

  return writes;
}

/**
 * Execute a descriptor's declared workspace writes under `workspacePath`.
 * Returns the absolute paths written, in order. A `relPath` that escapes the
 * workspace throws before anything is written.
 */
export function executeWorkspaceWrites(
  workspacePath: string,
  writes: WorkspaceWriteSpec[],
): string[] {
  // Resolve every target FIRST so one escaping path aborts the whole batch
  // rather than leaving a half-applied set of files behind.
  const targets = writes.map((write) => ({
    write,
    absPath: resolveTarget(workspacePath, write.relPath),
  }));

  const written: string[] = [];
  for (const { write, absPath } of targets) {
    if (write.format === "json") applyJsonWrite(absPath, write.ops);
    else applyTextWrite(absPath, write.ops);
    written.push(absPath);
  }
  return written;
}

/**
 * Validate a raw descriptor and apply its workspace writes in one call: the
 * shape a launch pipeline uses.
 */
export function runLaunchDescriptor(
  raw: unknown,
  workspacePath: string,
  opts: { posture?: AgentPosture } = {},
): { descriptor: AgentLaunchDescriptor; written: string[] } {
  const descriptor = validateDescriptor(raw);
  const written = executeWorkspaceWrites(workspacePath, collectWorkspaceWrites(descriptor, opts));
  return { descriptor, written };
}

// --- internals --------------------------------------------------------------

function resolveTarget(workspacePath: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new AgentDescriptorError(
      `Workspace write path "${relPath}" must be relative to the bench workspace`,
    );
  }
  try {
    // Two barriers, the pairing every synchronous fs write sink in this repo
    // uses. resolveWithin is lexical (path.resolve + path.relative) and cannot
    // see an on-disk symlink; a symlinked DIRECTORY component under the
    // workspace (`<workspace>/link` -> somewhere else) would otherwise pass it,
    // and the later recursive mkdirSync + write would follow the link straight
    // out of the workspace. assertRealpathWithin resolves symlinks on the
    // deepest existing ancestor and closes that hole, which is what makes
    // AP-NFR-001's "confined to the bench workspace" actually hold.
    const resolved = resolveWithin(workspacePath, relPath);
    assertRealpathWithin(workspacePath, resolved, "workspace write path");
    return resolved;
  } catch (err) {
    if (err instanceof UnsafePathError) {
      throw new AgentDescriptorError(
        `Workspace write path "${relPath}" escapes the bench workspace`,
      );
    }
    throw err;
  }
}

// `__proto__` / `prototype` / `constructor` in a plugin-supplied dotted path
// would otherwise reach an inherited object property. Reject them outright
// rather than silently skipping, so a malicious descriptor fails loudly.
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function splitPath(dotted: string): string[] {
  const segments = dotted.split(".");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new AgentDescriptorError(`Invalid write-op path "${dotted}": empty segment`);
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new AgentDescriptorError(`Invalid write-op path "${dotted}": unsafe segment`);
    }
  }
  return segments;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // An unparseable file is treated as empty, matching writeClaudeSettingsLocal.
    return {};
  }
}

function containerFor(
  root: Record<string, unknown>,
  segments: string[],
  create: boolean,
): Record<string, unknown> | undefined {
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (next !== null && typeof next === "object" && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
      continue;
    }
    if (!create) return undefined;
    const fresh: Record<string, unknown> = {};
    cursor[segment] = fresh;
    cursor = fresh;
  }
  return cursor;
}

/**
 * Apply ops in order against the PARSED existing file, so unknown keys the user
 * (or another tool) put there survive. This is the same preserve-unknown-keys
 * contract `writeClaudeSettingsLocal` honours today.
 */
function applyJsonWrite(filePath: string, ops: WriteOp[]): void {
  const doc = readJsonObject(filePath);

  for (const op of ops) {
    const segments = splitPath(op.path);
    const leaf = segments[segments.length - 1];

    if (op.op === "delete") {
      const container = containerFor(doc, segments, false);
      // Reflect.deleteProperty rather than `delete container[leaf]`: the leaf is
      // plugin-supplied, and a dynamic `delete` is what the lint rule guards
      // against. splitPath has already rejected the prototype-reaching names.
      if (container) Reflect.deleteProperty(container, leaf);
      continue;
    }

    const container = containerFor(doc, segments, true);
    if (!container) continue;

    if (op.op === "set") {
      container[leaf] = op.value;
      continue;
    }

    // unionArray: the merge semantics of mergePermissions, order-preserving with
    // existing values first so a resync never reshuffles the user's file.
    const existing = container[leaf];
    const existingValues = Array.isArray(existing)
      ? existing.filter((v): v is string => typeof v === "string")
      : [];
    container[leaf] = [...new Set([...existingValues, ...op.values])];
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, JSON.stringify(doc, null, 2));
}

/**
 * Text-format writes address the whole file body, not a structured path, so only
 * two ops are meaningful: `set` (replace the body, value must be a string) and
 * `delete` (remove the file). `unionArray` has no text meaning and is rejected
 * rather than silently ignored.
 */
function applyTextWrite(filePath: string, ops: WriteOp[]): void {
  let body: string | null = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;

  for (const op of ops) {
    if (op.op === "set") {
      if (typeof op.value !== "string") {
        throw new AgentDescriptorError(
          `Text workspace write at "${op.path}" requires a string value`,
        );
      }
      body = op.value;
      continue;
    }
    if (op.op === "delete") {
      body = null;
      continue;
    }
    throw new AgentDescriptorError(
      `Write op "${op.op}" is not supported for a text-format workspace write`,
    );
  }

  if (body === null) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, body);
}
