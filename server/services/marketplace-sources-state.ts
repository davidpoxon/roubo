import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  MARKETPLACE_SOURCES_STATE_SCHEMA_VERSION,
  MarketplaceSourcesStateSchema,
  type MarketplaceSource,
  type MarketplaceSourcesState,
  type MarketplaceSourceSummary,
} from "@roubo/shared";
import { atomicWrite, ensureDirs, getRouboDir } from "./state.js";
import * as credentialStore from "./credential-store.js";

// Issue #553 / CPHMTP-FR-001, CPHMTP-FR-003, CPHMTP-NFR-002, CPHMTP-NFR-003:
// persistent registry of third-party marketplace sources. See:
//   .specifications/component-plugins-hosted-marketplace-third-party/prd.md
//   .specifications/component-plugins-hosted-marketplace-third-party/architecture.md
//     ('Data model', 'Client -> sources API')
//
// Pure persistence module, a structural sibling of plugin-consent-state.ts. Reads
// and writes ~/.roubo/marketplace-sources.json via the same atomicWrite discipline
// used by state.json and plugins-consent.json. The persisted row doubles as the
// FR-002 registration consent record. Credentials never touch this file: they live
// in the OS keyring under account `source:<id>/token` (via credential-store) and
// the row carries only a `hasCredential` boolean (CPHMTP-NFR-002).
//
// Registration is a PURE WRITE (CPHMTP-NFR-003): adding a source validates the URL
// shape and persists the row, but performs NO network call to the candidate URL.
// The first fetch happens only on the next marketplace listing.

const FILE_NAME = "marketplace-sources.json";

function filePath(): string {
  return path.join(getRouboDir(), FILE_NAME);
}

// The built-in first-party catalog, synthesised into the list and NON-REMOVABLE.
// Its URL mirrors DEFAULT_CATALOG_URL in catalog-client.ts (kept local so this
// module stays decoupled from the signed-chain client construction). The reserved
// id can never collide with a generated third-party id: generated ids end in an
// 8-char hex suffix, and "party" is not hex.
export const FIRST_PARTY_SOURCE_ID = "first-party";
const FIRST_PARTY_URL = "https://davidpoxon.github.io/roubo-plugins/catalog.json";
// Sentinel timestamp for the always-present built-in (registered since first
// launch); the row exists by construction rather than by a registration event.
const FIRST_PARTY_REGISTERED_AT = "1970-01-01T00:00:00.000Z";

const FIRST_PARTY_SUMMARY: MarketplaceSourceSummary = {
  id: FIRST_PARTY_SOURCE_ID,
  url: FIRST_PARTY_URL,
  hasCredential: false,
  registeredAt: FIRST_PARTY_REGISTERED_AT,
};

// Last successfully loaded or saved state, kept in-process so a corrupted file
// mid-session can fall back to "what we knew last" instead of resetting. Reset by
// `__test.reset()`.
let lastKnown: MarketplaceSourcesState | null = null;

/**
 * Loads `~/.roubo/marketplace-sources.json`. Returns `null` when the file is
 * absent: callers interpret this as "no third-party source registered yet".
 *
 * On JSON.parse failure or schema rejection, the bad file is renamed to
 * `marketplace-sources.json.broken-<ISO-timestamp>` and the function returns the
 * last successful in-memory snapshot if one exists, otherwise `null`.
 */
export function loadSourcesState(): MarketplaceSourcesState | null {
  ensureDirs();
  const p = filePath();
  if (!fs.existsSync(p)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    console.warn(`marketplace-sources-state: failed to read ${p}:`, (err as Error).message);
    return lastKnown;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return backupAndRecover(p, `invalid JSON: ${(err as Error).message}`);
  }
  const result = MarketplaceSourcesStateSchema.safeParse(parsed);
  if (!result.success) {
    return backupAndRecover(p, `schema rejected: ${result.error.message}`);
  }
  lastKnown = result.data;
  return result.data;
}

/**
 * Writes the state via atomicWrite (tmp + rename) and updates the in-process
 * `lastKnown` cache. Validates before persisting so a buggy caller cannot write a
 * file the next load would reject and back up.
 */
export function saveSourcesState(state: MarketplaceSourcesState): void {
  ensureDirs();
  const validated = MarketplaceSourcesStateSchema.parse(state);
  atomicWrite(filePath(), JSON.stringify(validated, null, 2));
  lastKnown = validated;
}

/** True for the reserved, non-removable built-in first-party source id. */
export function isFirstParty(id: string): boolean {
  return id === FIRST_PARTY_SOURCE_ID;
}

/** The persisted third-party sources (excludes the synthesised first-party row). */
export function listSources(): MarketplaceSource[] {
  return loadSourcesState()?.sources ?? [];
}

/**
 * The list served by `GET /api/marketplace/sources`: the built-in first-party
 * source first, then every registered third-party source, projected to the API
 * shape. Never carries a credential (CPHMTP-NFR-002); only `hasCredential`.
 */
export function listSourceSummaries(): MarketplaceSourceSummary[] {
  const thirdParty = listSources().map(
    (s): MarketplaceSourceSummary => ({
      id: s.id,
      url: s.url,
      hasCredential: s.hasCredential,
      registeredAt: s.registeredAt,
    }),
  );
  return [FIRST_PARTY_SUMMARY, ...thirdParty];
}

function toSummary(source: MarketplaceSource): MarketplaceSourceSummary {
  return {
    id: source.id,
    url: source.url,
    hasCredential: source.hasCredential,
    registeredAt: source.registeredAt,
  };
}

// Slug derived from the URL host plus a short digest of the normalised href.
// Deterministic (same URL -> same id) so a re-registration resolves to the same
// row and keyring account. Restricted to `[a-z0-9-]` so it is safe as a keyring
// account segment and a cache directory name. Splitting on non-alphanumeric runs
// (rather than a trailing-quantifier regex) avoids the polynomial-redos shape the
// repo's path helpers deliberately steer clear of.
function slugFromUrl(normalizedHref: string, host: string): string {
  const hostSlug =
    host
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .join("-") || "source";
  const digest = createHash("sha256").update(normalizedHref).digest("hex").slice(0, 8);
  return `${hostSlug}-${digest}`;
}

/**
 * Validates the URL shape and returns its normalised href plus generated id.
 * No network call is made (CPHMTP-NFR-003). Rules: must parse as a WHATWG URL;
 * scheme must be https or http; an `http:` URL is allowed only when `allowHttp`
 * is set (Spike 551). Returns `null` when the URL is rejected.
 */
function validateAndNormalize(
  url: string,
  allowHttp: boolean,
): { href: string; id: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    return null;
  }
  return { href: parsed.href, id: slugFromUrl(parsed.href, parsed.host) };
}

function keyringAccount(id: string): string {
  // credential-store composes the account as `${pluginId}/${slot}`; passing
  // `source:<id>` as the pluginId yields the account `source:<id>/token`. The
  // `source:` prefix prevents collision with plugin ids (architecture note).
  return `source:${id}`;
}

async function storeCredential(id: string, credential: string): Promise<void> {
  await credentialStore.set(keyringAccount(id), "token", credential);
}

async function deleteCredential(id: string): Promise<void> {
  await credentialStore.deleteSlot(keyringAccount(id), "token");
}

function sourceCacheDir(id: string): string {
  return path.join(getRouboDir(), "marketplace", "sources", id);
}

export type AddSourceResult =
  | { outcome: "created"; source: MarketplaceSourceSummary }
  | { outcome: "replaced"; source: MarketplaceSourceSummary }
  | { outcome: "invalid-url" };

/**
 * Registers a source. PURE WRITE: validates the URL shape and persists the row
 * plus (optionally) the keyring credential; performs NO network call to the
 * candidate URL (CPHMTP-NFR-003).
 *
 * - New URL -> persists a fresh row and returns `created`.
 * - Already-registered URL -> creates NO second entry; if a credential is
 *   supplied it REPLACES the stored one (the v1 rotation UX), and the outcome is
 *   `replaced`. The original `registeredAt` (consent stamp) is preserved.
 * - Malformed / disallowed URL -> `invalid-url` (no write).
 */
export async function addSource(input: {
  url: unknown;
  credential?: unknown;
  allowHttp?: unknown;
}): Promise<AddSourceResult> {
  if (typeof input.url !== "string") {
    return { outcome: "invalid-url" };
  }
  const allowHttp = input.allowHttp === true;
  const credential =
    typeof input.credential === "string" && input.credential.length > 0
      ? input.credential
      : undefined;

  const validated = validateAndNormalize(input.url, allowHttp);
  if (!validated) {
    return { outcome: "invalid-url" };
  }

  // The built-in first-party catalog is reserved: registering its URL as a
  // third-party source would surface a removable unsigned duplicate of the
  // non-removable built-in in GET /sources (the duplicate check below only scans
  // persisted third-party rows). It is a well-formed URL but not a valid
  // third-party source to register, so reject it as invalid.
  if (validated.href === FIRST_PARTY_URL) {
    return { outcome: "invalid-url" };
  }

  const current = loadSourcesState() ?? {
    schemaVersion: MARKETPLACE_SOURCES_STATE_SCHEMA_VERSION,
    sources: [],
  };
  const existing = current.sources.find((s) => s.url === validated.href);

  if (existing) {
    // Re-registration: replace the credential (if supplied) without adding a
    // second entry. Store to the keyring first so a keyring failure aborts before
    // we mutate the row's hasCredential flag.
    let hasCredential = existing.hasCredential;
    if (credential !== undefined) {
      await storeCredential(existing.id, credential);
      hasCredential = true;
    }
    const updated: MarketplaceSource = { ...existing, hasCredential, allowHttp };
    const next: MarketplaceSourcesState = {
      ...current,
      sources: current.sources.map((s) => (s.id === existing.id ? updated : s)),
    };
    saveSourcesState(next);
    return { outcome: "replaced", source: toSummary(updated) };
  }

  // Fresh registration. Store the credential to the keyring before persisting the
  // row so a keyring failure never leaves a row claiming a credential it lacks.
  if (credential !== undefined) {
    await storeCredential(validated.id, credential);
  }
  const row: MarketplaceSource = {
    id: validated.id,
    url: validated.href,
    unsigned: true,
    hasCredential: credential !== undefined,
    allowHttp,
    registeredAt: new Date().toISOString(),
  };
  const next: MarketplaceSourcesState = {
    ...current,
    sources: [...current.sources, row],
  };
  saveSourcesState(next);
  return { outcome: "created", source: toSummary(row) };
}

export type RemoveSourceResult = "removed" | "not-found" | "first-party";

/**
 * Removes a registered source: deletes the row, its per-source cache directory,
 * and its keyring credential. The built-in first-party source is NON-REMOVABLE.
 *
 * Note: stamping `orphaned: true` on installed PluginRecords (CPHMTP-FR-009) is a
 * later slice and out of scope for issue #553.
 */
export async function removeSource(id: string): Promise<RemoveSourceResult> {
  if (isFirstParty(id)) {
    return "first-party";
  }
  const current = loadSourcesState();
  const existing = current?.sources.find((s) => s.id === id);
  if (!current || !existing) {
    return "not-found";
  }

  const next: MarketplaceSourcesState = {
    ...current,
    sources: current.sources.filter((s) => s.id !== id),
  };
  saveSourcesState(next);

  // Best-effort side-effect cleanup, all AFTER the row is already persisted above:
  // a cleanup failure must not turn an already-completed removal into an error. The
  // cache dir may not exist yet (POST is a pure write, so nothing is fetched until
  // the next listing); force ignores that. The keyring credential is deleted only
  // when the row claimed one, and a keyring failure (e.g. an unavailable headless
  // Linux keyring) is logged rather than propagated so the removal still reports as
  // completed.
  fs.rmSync(sourceCacheDir(id), { recursive: true, force: true });
  if (existing.hasCredential) {
    try {
      await deleteCredential(id);
    } catch (err) {
      console.warn(
        `marketplace-sources-state: failed to delete keyring credential for source "${id}": ${(err as Error).message}`,
      );
    }
  }

  return "removed";
}

function backupAndRecover(p: string, reason: string): MarketplaceSourcesState | null {
  const backup = `${p}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(p, backup);
    console.warn(
      `marketplace-sources-state: ${path.basename(p)} corrupt (${reason}); backed up to ${path.basename(backup)}`,
    );
  } catch (err) {
    console.warn(
      `marketplace-sources-state: ${path.basename(p)} corrupt (${reason}); backup to ${path.basename(backup)} failed: ${(err as Error).message}`,
    );
  }
  return lastKnown;
}

// Test-only reset so vitest module isolation can clear the in-process cache
// without leaking state between test files.
export const __test = {
  reset(): void {
    lastKnown = null;
  },
  getLastKnown(): MarketplaceSourcesState | null {
    return lastKnown;
  },
  sourceCacheDir,
  keyringAccount,
};
