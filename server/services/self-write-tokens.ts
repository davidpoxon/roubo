/**
 * Self-write tokens for the InputWatcher (HR-NFR-002).
 *
 * When the server writes one of its own watched inputs (through `atomicWrite`
 * in state.ts), the watcher sees the same change event a hand edit would
 * produce. To keep the server from re-applying its own write, the writer marks
 * the path and the content hash before the rename, and the watcher consumes the
 * matching token instead of running the surface handler.
 *
 * Tokens are held as a multiset for each path: two quick writes of the same
 * content leave two tokens, and each match consumes the oldest one, or, through
 * `consumeSelfWrites`, every write that one merged change accounts for. Every token
 * expires after `SELF_WRITE_TTL_MS`, so a write whose event never arrives does
 * not mask a later hand edit for long.
 *
 * App writes are often read-modify-write from disk, so one that lands inside
 * the settle window of a hand edit would carry the edit forward as part of its
 * own content and hide it from the watch. For an input whose watch tracks hand
 * edits (`noteInputContent`), the registry also keeps the content the app last
 * knows the file to hold. A token marked while the file holds something else
 * says the write carries a hand edit, and the watch then runs its handler for
 * the change. `pendingHandEdit` lets a writer base its change on the known
 * content, so the edit is not taken in as the app's own.
 *
 * This module deliberately imports nothing from state.ts: state.ts imports it to
 * mark its writes, and the watcher imports both, so keeping the registry here
 * leaves no import cycle between the writer and the watcher.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How long a self-write token stays live. */
export const SELF_WRITE_TTL_MS = 5_000;

interface Token {
  hash: string;
  expiresAt: number;
  /** The file held a hand edit that the app had not taken in when it wrote. */
  carriesHandEdit: boolean;
}

const tokens = new Map<string, Token[]>();

/**
 * The content that the app last knows each tracked input to hold: what it last
 * wrote there, or what its watch last read there. Only the inputs of a watch
 * that tracks hand edits are here. `raw` is null when the input was absent, and
 * undefined when only the hash is known.
 */
interface KnownContent {
  hash: string | null;
  raw?: string | null;
}

const known = new Map<string, KnownContent>();

/** The sha256 hex digest of some content, as the watcher hashes a file. */
export function hashContent(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * The canonical key of a path: absolute, with its parent directory resolved
 * through any symlink, so the writer's path and the watcher's event path agree
 * (for example `/var/...` and `/private/var/...` on macOS).
 */
export function canonicalInputPath(absPath: string): string {
  const resolved = path.resolve(absPath);
  const parent = path.dirname(resolved);
  try {
    return path.join(fs.realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function live(key: string, now: number): Token[] {
  const list = (tokens.get(key) ?? []).filter((t) => t.expiresAt > now);
  if (list.length === 0) tokens.delete(key);
  else tokens.set(key, list);
  return list;
}

function sweep(now: number): void {
  for (const key of [...tokens.keys()]) live(key, now);
}

/** The content of `key` on disk now: null when absent, undefined when it cannot be read. */
function readDisk(key: string): string | null | undefined {
  try {
    return fs.readFileSync(key, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

/** Whether the disk content of a tracked `key` differs from what the app knows it holds. */
function diskDiffersFromKnown(key: string): boolean {
  const entry = known.get(key);
  if (entry === undefined) return false;
  const disk = readDisk(key);
  if (disk === undefined) return false;
  return (disk === null ? null : hashContent(disk)) !== entry.hash;
}

/**
 * Record that the server is about to write `contentHash` to `absPath`. Call it
 * before the write replaces the file: for a tracked input, a file that holds
 * content the app does not know is a hand edit not yet taken in, and the token
 * says so, so the watch still runs its handler for the change (see
 * `consumeSelfWrites`). `content` is kept as the known content of a tracked
 * input: the written content, or, for a write that keeps a hand edit in the
 * file, the content without it, so the edit stays pending until the watch
 * runs for it.
 */
export function markSelfWrite(absPath: string, contentHash: string, content?: string): void {
  const now = Date.now();
  if (tokens.size > 256) sweep(now);
  const key = canonicalInputPath(absPath);
  const carriesHandEdit = diskDiffersFromKnown(key);
  const list = live(key, now);
  list.push({ hash: contentHash, expiresAt: now + SELF_WRITE_TTL_MS, carriesHandEdit });
  tokens.set(key, list);
  if (known.has(key)) {
    known.set(
      key,
      content === undefined ? { hash: contentHash } : { hash: hashContent(content), raw: content },
    );
  }
}

/**
 * Track the hand edits of `absPath`: a watch that applies them calls this for
 * each content it reads, `hash` being what it read. From then on an app write
 * of the path can tell whether the file holds a hand edit that the watch has
 * not taken in yet.
 */
export function noteInputContent(absPath: string, hash: string | null): void {
  const key = canonicalInputPath(absPath);
  if (hash === null) {
    known.set(key, { hash: null, raw: null });
    return;
  }
  const disk = readDisk(key);
  const raw = typeof disk === "string" && hashContent(disk) === hash ? disk : undefined;
  known.set(key, { hash, raw });
}

/** Stop tracking the hand edits of `absPath`, as when its watch is disposed. */
export function forgetInputContent(absPath: string): void {
  known.delete(canonicalInputPath(absPath));
}

/**
 * The hand edit that `absPath` holds and the app has not taken in yet, or
 * undefined when there is none or the path is not tracked. `known` is the
 * content the app last knew the file to hold, null when it was absent, and
 * undefined when only its hash is known. An app write that reads the file
 * first uses it to change only what the app means to change: the hand edit
 * stays in the file for the watch to apply or refuse, and is not taken in as
 * part of the app's own write.
 */
export function pendingHandEdit(absPath: string): { known: string | null | undefined } | undefined {
  const key = canonicalInputPath(absPath);
  if (!diskDiffersFromKnown(key)) return undefined;
  return { known: known.get(key)?.raw };
}

/**
 * Consume the oldest live token of `absPath` whose hash is `contentHash`.
 * Returns true when one was found, meaning the change is the server's own write.
 */
export function consumeSelfWrite(absPath: string, contentHash: string): boolean {
  const key = canonicalInputPath(absPath);
  const list = live(key, Date.now());
  const index = list.findIndex((t) => t.hash === contentHash);
  if (index === -1) return false;
  list.splice(index, 1);
  if (list.length === 0) tokens.delete(key);
  return true;
}

/** The app writes that one change of an input accounts for. */
export interface SelfWrites {
  /** The hash of each write, oldest first. Empty when the change is not the app's own write. */
  hashes: string[];
  /**
   * One of the writes landed on a hand edit that the app had not taken in: the
   * change holds that edit, so the watch runs its handler for it.
   */
  carriesHandEdit: boolean;
}

/**
 * Consume the self-write tokens that the content `contentHash` of `absPath`
 * accounts for. `hashes` is empty when the change is not the server's own
 * write.
 *
 * `atomicWrite` marks a token and renames in one synchronous step, so when the
 * newest live token matches what is on disk, every live token of the path is a
 * write that has already landed: back-to-back writes whose events the settle
 * window merged into one run. Each is consumed, so each write is counted once
 * and none is left to mask a later hand edit (HR-TC-031). Otherwise only the
 * oldest matching token is consumed, as `consumeSelfWrite` does.
 *
 * A change that matches no token, an absent input (`contentHash` null)
 * included, is not the app's own write, so the watch runs its handler for what
 * the file now holds, and that takes in any hand edit an earlier app write
 * landed on. The live tokens of the path then carry no hand edit any more: a
 * token left over from such a write would otherwise make a later plain app
 * write that consumes it run the handler for the app's own write (HR-TC-030).
 */
export function consumeSelfWrites(absPath: string, contentHash: string | null): SelfWrites {
  const key = canonicalInputPath(absPath);
  const list = live(key, Date.now());
  if (contentHash !== null && list.length > 0 && list[list.length - 1].hash === contentHash) {
    tokens.delete(key);
    return {
      hashes: list.map((t) => t.hash),
      carriesHandEdit: list.some((t) => t.carriesHandEdit),
    };
  }
  const index = contentHash === null ? -1 : list.findIndex((t) => t.hash === contentHash);
  if (index === -1) {
    for (const token of list) token.carriesHandEdit = false;
    return { hashes: [], carriesHandEdit: false };
  }
  const [token] = list.splice(index, 1);
  if (list.length === 0) tokens.delete(key);
  return { hashes: [token.hash], carriesHandEdit: token.carriesHandEdit };
}

/** Drop every token and every tracked content. For tests. */
export function resetSelfWriteTokens(): void {
  tokens.clear();
  known.clear();
}
