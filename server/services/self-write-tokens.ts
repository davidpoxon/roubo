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
}

const tokens = new Map<string, Token[]>();

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

/** Record that the server is about to write `contentHash` to `absPath`. */
export function markSelfWrite(absPath: string, contentHash: string): void {
  const now = Date.now();
  if (tokens.size > 256) sweep(now);
  const key = canonicalInputPath(absPath);
  const list = live(key, now);
  list.push({ hash: contentHash, expiresAt: now + SELF_WRITE_TTL_MS });
  tokens.set(key, list);
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

/**
 * Consume the self-write tokens that the content `contentHash` of `absPath`
 * accounts for, and return their hashes, oldest first. Empty when the change
 * is not the server's own write.
 *
 * `atomicWrite` marks a token and renames in one synchronous step, so when the
 * newest live token matches what is on disk, every live token of the path is a
 * write that has already landed: back-to-back writes whose events the settle
 * window merged into one run. Each is consumed, so each write is counted once
 * and none is left to mask a later hand edit (HR-TC-031). Otherwise only the
 * oldest matching token is consumed, as `consumeSelfWrite` does.
 */
export function consumeSelfWrites(absPath: string, contentHash: string): string[] {
  const key = canonicalInputPath(absPath);
  const list = live(key, Date.now());
  if (list.length > 0 && list[list.length - 1].hash === contentHash) {
    tokens.delete(key);
    return list.map((t) => t.hash);
  }
  return consumeSelfWrite(absPath, contentHash) ? [contentHash] : [];
}

/** Drop every token. For tests. */
export function resetSelfWriteTokens(): void {
  tokens.clear();
}
