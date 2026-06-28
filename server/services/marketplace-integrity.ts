import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Marketplace channel-integrity primitives (CP-FR-021, issue #622).
//
// The marketplace distributes executable code, so two layers of integrity are
// enforced server-side (the server is the authoritative gate; the client cannot
// be trusted):
//
//   1. Signed catalog: the static catalog is wrapped in a detached ed25519
//      signature over its canonical payload bytes, verified against the bundled
//      first-party public key below. An invalid or missing signature fails
//      closed (the caller surfaces zero listings).
//   2. Per-plugin integrity: each catalog entry carries an expected content
//      digest (`sha256-<hex>`) whose target is the unpacked built artifact (the
//      ReleaseAsset file set: dist/index.js + roubo-plugin.yaml + package.json +
//      README, with no `src/` and no `node_modules`), not the cloned source
//      subdir. The digest primitive and the catalog contract bind to that built
//      artifact (issue #765). Wiring the production install path to recompute
//      the digest over the unpacked artifact (rather than the cloned-source
//      staging tree it digests today) lands with the download/unpack installer
//      in #370; until then the installed digest input is unchanged.
//
// Verification uses node:crypto only (no third-party crypto dependency). The
// private signing key is held out of band by maintainers; only the public key
// is checked in here. Re-signing the catalog after an edit is a documented
// maintainer step (see server/scripts/sign-marketplace-catalog.ts).

/**
 * Bundled first-party catalog-signing public key (ed25519, SPKI PEM). The
 * matching private key is held out of band by Roubo maintainers and is never
 * committed. Rotating this key requires re-signing the catalog with the new
 * private key and replacing this constant in the same change.
 */
export const CATALOG_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWk7+soWCgnhP6l8MCGBW0poQu7vmmw77eo5QiVieVIk=
-----END PUBLIC KEY-----`;

/**
 * Embedded bootstrap ROOT public key (ed25519, SPKI PEM) that anchors the
 * hosted-marketplace trust chain. The matching private key signs the published
 * key-ring (held out of band, in the roubo-plugins release CI secret); the app
 * verifies the fetched key-ring against this key, then resolves the catalog's
 * operational key through the ring. Only a ROOT-key change requires an app
 * release; operational keys rotate via the signed key-ring (CPHM-FR-007 /
 * CPHM-NFR-004).
 *
 * This is the real published bootstrap root public key (davidpoxon/roubo-development#368).
 * Its private half is held only in the roubo-plugins release CI secret
 * (`MARKETPLACE_ROOT_SIGNING_KEY`) and signs the published key-ring; it is never
 * committed. With the real key embedded, the fetched key-ring verifies and the
 * catalog-client activates hosted network fetch (rather than staying pinned to
 * the on-disk cache / bundled seed). Rotating this key is the one marketplace
 * change that requires a new app release.
 */
export const CATALOG_ROOT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAa/6jBpbpxY+6fxdDdrz4hOeNpB+3TRwnFLB62yfWsNM=
-----END PUBLIC KEY-----`;

/**
 * Deterministically canonicalize a JSON value: object keys are sorted
 * recursively and there is no insignificant whitespace. The signature is
 * computed over these bytes, so the signing script and the verifier must agree
 * on this exact serialization.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical payload bytes that the catalog signature covers. */
export function canonicalPayloadBytes(payload: unknown): Buffer {
  return Buffer.from(canonicalize(payload), "utf8");
}

/**
 * Verify a detached ed25519 signature (base64) over a JSON payload's canonical
 * bytes. `publicKeyPem` defaults to the bundled first-party key (the seed /
 * legacy single-key path); the hosted catalog passes the operational key
 * resolved from the signed key-ring (see `resolveActiveKey`). Returns true only
 * on a valid signature; any malformed input (bad base64, wrong key, tampered
 * payload, unparseable key) returns false. Never throws: the caller fails closed
 * on a false result.
 */
export function verifyCatalogSignature(
  payload: unknown,
  signatureBase64: string,
  publicKeyPem: string = CATALOG_PUBLIC_KEY_PEM,
): boolean {
  if (typeof signatureBase64 !== "string" || signatureBase64.length === 0) {
    return false;
  }
  try {
    const key = createPublicKey(publicKeyPem);
    const sig = Buffer.from(signatureBase64, "base64");
    return verify(null, canonicalPayloadBytes(payload), key, sig);
  } catch {
    return false;
  }
}

/**
 * One key-ring entry as resolved from a verified key-ring. This mirrors
 * `KeyRingEntry` in `@roubo/shared`, but is declared locally so this host
 * verifier imports `node:` builtins only and pulls in no non-builtin module
 * (the zero-dependency invariant, CPHM-NFR-006, asserted by the publish e2e).
 */
export interface KeyRingKey {
  keyId: string;
  publicKeyPem: string;
  status: "active" | "revoked";
}

/**
 * Stable key id: `ed25519-` + the first 16 hex chars of the sha256 of the
 * public key's SPKI DER. This MUST match the producer-side derivation in
 * roubo-plugins (`scripts/release/keys.mjs#fingerprintKeyId`), because a
 * catalog's `payload.keyId` and a key-ring entry's `keyId` are both produced by
 * that scheme and resolved against each other here. Do not change the prefix,
 * the hash, or the truncation without a coordinated cross-repo change.
 */
export function fingerprintKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `ed25519-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

/**
 * Verify a signed key-ring envelope (`{ payload: { keys }, signature }`) against
 * the embedded bootstrap ROOT public key, fail-closed. On a valid signature
 * returns the ring's keys indexed by `keyId`; on any malformed envelope, bad
 * signature, or unparseable root key returns null (never throws). This mirrors,
 * on the client, step 1 of the producer publish gate
 * (roubo-plugins `scripts/release/verify-keyring.mjs`).
 *
 * `rootPublicKeyPem` defaults to the embedded bootstrap root key; it is a
 * parameter only so tests can anchor a throwaway ring to a generated root.
 */
export function verifyKeyRing(
  envelope: unknown,
  rootPublicKeyPem: string = CATALOG_ROOT_PUBLIC_KEY_PEM,
): Map<string, KeyRingKey> | null {
  if (envelope === null || typeof envelope !== "object") return null;
  const { payload, signature } = envelope as { payload?: unknown; signature?: unknown };
  if (typeof signature !== "string" || signature.length === 0) return null;
  if (payload === null || typeof payload !== "object") return null;
  const keys = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;

  let ringSignatureValid: boolean;
  try {
    const root = createPublicKey(rootPublicKeyPem);
    ringSignatureValid = verify(
      null,
      canonicalPayloadBytes(payload),
      root,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return null;
  }
  if (!ringSignatureValid) return null;

  const ring = new Map<string, KeyRingKey>();
  for (const raw of keys) {
    if (raw === null || typeof raw !== "object") continue;
    const { keyId, publicKeyPem, status } = raw as Partial<KeyRingKey>;
    if (
      typeof keyId === "string" &&
      typeof publicKeyPem === "string" &&
      (status === "active" || status === "revoked")
    ) {
      ring.set(keyId, { keyId, publicKeyPem, status });
    }
  }
  return ring;
}

/**
 * Resolve a catalog's `keyId` to its operational signing key's PEM, fail-closed.
 * Returns the `publicKeyPem` only when the ring holds a matching key whose
 * `status` is `active` AND whose own fingerprint equals the `keyId` it is filed
 * under (so a root-signed ring that mislabels a key, or a catalog naming an
 * unknown or revoked key, is rejected). Returns null otherwise. Mirrors step 2
 * of the producer publish gate.
 */
export function resolveActiveKey(ring: Map<string, KeyRingKey>, keyId: string): string | null {
  if (typeof keyId !== "string" || keyId.length === 0) return null;
  const entry = ring.get(keyId);
  if (!entry || entry.status !== "active") return null;
  try {
    if (fingerprintKeyId(createPublicKey(entry.publicKeyPem)) !== keyId) return null;
  } catch {
    return null;
  }
  return entry.publicKeyPem;
}

/**
 * Compute the content digest of a plugin package directory as `sha256-<hex>`.
 * The walk is generic over whatever directory it is handed; the intended digest
 * target is the unpacked built artifact (the ReleaseAsset file set: dist/index.js
 * + roubo-plugin.yaml + package.json + README), not the cloned source subdir,
 * because an installed plugin runs from `dist/`, so binding integrity to the
 * built artifact is what makes the check meaningful (issue #765). The catalog
 * contract and these primitives' tests bind to that built artifact. The
 * production install path still hands this function its cloned-source staging
 * tree; pointing it at the unpacked artifact lands with the download/unpack
 * installer in #370.
 *
 * The digest is normalized and deterministic: relative paths are sorted, path
 * separators normalized to "/", and the `.git` directory is excluded (it is
 * non-deterministic and never present in a distributed artifact). The hash mixes
 * each file's relative path and its bytes, so both content and layout changes
 * are detected.
 */
export async function computePackageDigest(dir: string): Promise<string> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      } else if (entry.isSymbolicLink()) {
        // Resolve to a file/dir if it points within the package; otherwise skip.
        try {
          const s = await stat(abs);
          if (s.isFile()) files.push(abs);
          else if (s.isDirectory()) await walk(abs);
        } catch {
          // Dangling symlink: ignore.
        }
      }
    }
  }

  await walk(dir);

  const relSorted = files.map((abs) => ({
    abs,
    rel: path.relative(dir, abs).split(path.sep).join("/"),
  }));
  relSorted.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  for (const { abs, rel } of relSorted) {
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(await readFile(abs));
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
}

/**
 * Verify a package directory's content digest against the expected digest from
 * the signed catalog entry, the directory's intended target being the unpacked
 * built artifact (see `computePackageDigest`). Returns true only on an exact
 * match. A null/empty expected digest returns false (an entry with no integrity
 * field cannot be trusted). A tampered artifact (any changed or added file)
 * yields a different digest and is rejected fail-closed. Never throws on a
 * mismatch; only filesystem errors from `computePackageDigest` propagate.
 */
export async function verifyPackageIntegrity(
  dir: string,
  expected: string | null | undefined,
): Promise<boolean> {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const actual = await computePackageDigest(dir);
  return actual === expected;
}
