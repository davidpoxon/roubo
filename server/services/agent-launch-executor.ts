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
import { resolveTemplate, type ResolvedTemplateContext } from "./config-parser.js";

// AgentLaunchExecutor (#1026, AP-FR-001, AP-NFR-001).
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
 * notification wiring's carrier write when the agent uses the `http-hook` or
 * `file-notifier` shape (both register their hook in a workspace file, so both
 * travel this one path-validated route). Capability absence is
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

  const notification = capabilities.notification;
  if (notification?.kind === "http-hook" || notification?.kind === "file-notifier") {
    writes.push(notification.carrier.workspaceWrite);
  }

  return writes;
}

/**
 * Join a `file-notifier` carrier's resolved args into the one command string its
 * registration write embeds as `{{notifierCommand}}` (#1264). The agent
 * runs that string through a shell, so every element is POSIX-quoted: an element
 * made only of characters no shell treats specially passes through bare, and
 * anything else (whitespace, quotes, `$`, `;`, an empty string) is wrapped in
 * single quotes with each embedded single quote written as `'\''`. A workspace
 * path with a space in it therefore stays one word, and nothing a template
 * resolves to can inject a second command.
 */
export function joinShellCommand(args: string[]): string {
  return args.map(quoteShellWord).join(" ");
}

function quoteShellWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
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

/**
 * Resolve `{{sessionId}}` / `{{port}}` / `{{workspace}}` through a descriptor's
 * workspace writes. Both the target path and every string reachable from a write
 * op's value are resolved, because an http-hook carrier write embeds the session
 * id and port inside the JSON value it sets, not in the path.
 */
export function resolveWriteTemplates(
  writes: WorkspaceWriteSpec[],
  ctx: ResolvedTemplateContext,
): WorkspaceWriteSpec[] {
  return writes.map((write) => ({
    ...write,
    relPath: resolveTemplate(write.relPath, ctx),
    ops: write.ops.map((op): WriteOp => {
      if (op.op === "set") return { ...op, value: resolveJsonTemplates(op.value, ctx) };
      if (op.op === "unionArray") {
        return { ...op, values: op.values.map((v) => resolveTemplate(v, ctx)) };
      }
      if (op.op === "upsertArray") {
        // Both halves carry templates: the entry the host writes, and the needle
        // that recognises the entry it wrote last time. Resolving only the first
        // would leave the match hunting for a literal `{{...}}` and append a
        // second entry on every launch.
        return {
          ...op,
          value: resolveUpsertEntry(op.value, ctx),
          match: { ...op.match, contains: resolveTemplate(op.match.contains, ctx) },
        };
      }
      return op;
    }),
  }));
}

type WriteOpJsonValue = Extract<WriteOp, { op: "set" }>["value"];
type UpsertEntry = Extract<WriteOp, { op: "upsertArray" }>["value"];

function resolveUpsertEntry(value: UpsertEntry, ctx: ResolvedTemplateContext): UpsertEntry {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveJsonTemplates(entry, ctx)]),
  );
}

function resolveJsonTemplates(
  value: WriteOpJsonValue,
  ctx: ResolvedTemplateContext,
): WriteOpJsonValue {
  if (typeof value === "string") return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => resolveJsonTemplates(entry, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveJsonTemplates(entry, ctx)]),
    );
  }
  return value;
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
    // An unparseable file is treated as empty, matching the removed built-in writer.
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
 * Undo the one rewrite `quoteShellWord` performs inside a quoted word: a single
 * quote cannot appear inside single quotes, so it is written as `'\''` (close,
 * escaped quote, reopen). Wrapping quotes are left alone, since they only ever
 * add characters around a needle rather than inside it.
 */
function unquoteShellEscapes(value: string): string {
  return value.split("'\\''").join("'");
}

/**
 * Does this existing array entry belong to the writer the `upsertArray` op
 * declared? Own properties only: reading a plugin-named key straight off the
 * entry would otherwise reach an inherited one, the same hole `splitPath`
 * closes for paths. Nothing a plain object inherits holds a string, so the
 * type test below would refuse those anyway; the own-property test is the
 * cheap half of the pair and does not depend on that staying true.
 *
 * The value is tested a second time with shell single-quote escaping undone,
 * because a carrier that joins a value into a command string puts it through
 * `quoteShellWord` (#1344). Quoting only wraps, so for almost every value
 * the needle is still a substring of the raw command and the second test
 * changes nothing. The exception is a value containing a single quote, which
 * quoting rewrites as `'\''`: the needle is then nowhere in the command as
 * written, and undoing that one rewrite is what finds the entry this host wrote
 * last time. Missing it would append a second entry on every launch rather than
 * replacing the first. Undoing the rewrite rather than re-quoting the needle is
 * what makes a needle naming only part of the value work too, which is the
 * shape the SDK documentation recommends.
 */
function matchesUpsert(entry: unknown, match: { key: string; contains: string }): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!Object.prototype.hasOwnProperty.call(entry, match.key)) return false;
  const value = (entry as Record<string, unknown>)[match.key];
  if (typeof value !== "string") return false;
  return value.includes(match.contains) || unquoteShellEscapes(value).includes(match.contains);
}

/**
 * Apply ops in order against the PARSED existing file, so unknown keys the user
 * (or another tool) put there survive. This is the same preserve-unknown-keys
 * contract the removed built-in writer honoured.
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

    if (op.op === "upsertArray") {
      // The array-of-objects counterpart to unionArray, for a file whose entries
      // are objects rather than strings (#1344). Everything the match does
      // not select is kept, in order, and the new entry goes last, so a user's
      // own entries survive and the one this host wrote on an earlier launch is
      // replaced rather than joined by a second copy.
      const current = container[leaf];
      const kept = Array.isArray(current)
        ? current.filter((entry) => !matchesUpsert(entry, op.match))
        : [];
      container[leaf] = [...kept, op.value];
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
 * `delete` (remove the file). `unionArray` and `upsertArray` address a value at
 * a path inside a parsed document, so neither has a text meaning, and both are
 * rejected rather than silently ignored.
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
