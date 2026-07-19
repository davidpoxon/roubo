import { Router } from "express";
import type {
  InstallErrorCode,
  MarketplaceAmbiguousSourceErrorBody,
  MarketplaceCatalogResponse,
  MarketplaceKind,
} from "@roubo/shared";
import * as marketplace from "../services/marketplace.js";
import * as pluginInstaller from "../services/plugin-installer.js";
import * as sourcesState from "../services/marketplace-sources-state.js";

// Marketplace routes (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621;
// CP-FR-021 / CP-US-011, issue #622).
//
//   GET  /api/marketplace/plugins?q=&kind=&sourceId=   merged catalog, annotated
//   POST /api/marketplace/plugins/:id/install  { sourceId? } -> InstallPreview
//   POST /api/marketplace/plugins/:id/update   { sourceId? } -> InstallPreview
//
// Install/update return a staging token; the client drives the existing
// `/api/plugins/install/:token/confirm` and `/cancel` endpoints for the commit
// step (the same consent flow component installs already use). There is no
// third-party submission route here: entries come from the first-party curated
// catalog and from sources the consumer explicitly registered.
//
// Multi-source listing (issue #557): GET /plugins serves the MERGED catalog
// (first-party plus every registered source, fetched concurrently), each listing
// stamped with its `sourceId`, plus a per-source `sources` status array. `sourceId`
// scopes the list to one source.
//
// Cross-source collisions (issue #558, CPHMTP-FR-005): a listing whose id is served
// by several sources carries a `collision`, and install/update of such an id is
// refused with 409 `{ code: "ambiguous-source", sourceIds }` unless the body names
// a `sourceId`. There is no precedence: the server never picks a source for the
// caller. Naming a source is also what makes a THIRD-PARTY entry installable at
// all (it selects the unsigned source's trust treatment: mandatory per-artifact
// digest and origin-scoped download), so install/update are no longer
// first-party-only.
//
// Channel integrity (issue #622) + hosted catalog (issue #306): the catalog is
// fetched + verified per request via the catalog-client, which degrades
// NETWORK -> CACHE, bottoming out at an empty listing (the first-party SEED
// channel was retired in davidpoxon/roubo-development#621). Install/update map
// integrity-failed (422), revoked (410), and marketplace-unreachable (503, the
// catalog is degraded to cache) codes.

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;

function badId(id: string): boolean {
  return !PLUGIN_ID_RE.test(id);
}

function installErrorStatus(code: InstallErrorCode): number {
  switch (code) {
    case "invalid-input":
    case "clone-failed":
    case "download-failed": // release-asset fetch failure; mirrors clone-failed (#370)
    case "missing-manifest":
    case "invalid-manifest":
    case "incompatible-host":
      return 400;
    case "duplicate-id":
      return 409;
    case "unknown-token":
    case "update-target-missing":
      return 404;
    // A revoked / taken-down plugin: 410 Gone is the precise status.
    case "revoked":
      return 410;
    // A tampered package whose digest does not match the signed catalog entry:
    // 422 Unprocessable Entity (the request was well-formed but the content
    // failed verification). unpack-failed (zip-slip / bad entry / over limit) is
    // the same unprocessable-content class (#370). missing-integrity (an unsigned
    // entry with no usable per-artifact digest, #559) is the same class: the
    // request is well-formed but the entry is unverifiable, so it is refused
    // before any artifact is fetched.
    case "integrity-failed":
    case "unpack-failed":
    case "missing-integrity":
      return 422;
    // The marketplace is unreachable (catalog served from cache), so a new
    // install/update is paused: 503 Service Unavailable.
    case "marketplace-unreachable":
      return 503;
    // An unverified catalog should never reach an install/update, but map it
    // defensively to 502 Bad Gateway.
    case "catalog-unverified":
      return 502;
    case "internal":
      return 500;
  }
}

function sendInstallError(
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  err: unknown,
): void {
  if (err instanceof pluginInstaller.InstallError) {
    res.status(installErrorStatus(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: (err as Error).message, code: "internal" });
}

function parseKind(raw: unknown): MarketplaceKind | undefined {
  return raw === "component" || raw === "integration" ? raw : undefined;
}

/**
 * The id is served by several sources and the request named none, so the
 * install/update is refused with 409 and the contributing source ids
 * (CPHMTP-FR-005, issue #558). The client renders one explicit
 * install-from-<source> choice per id and re-issues the request with a `sourceId`.
 *
 * Its own sender rather than a `sendInstallError` code: `sendInstallError`
 * flattens every body to `{ error, code }`, which would drop the `sourceIds` the
 * client needs to offer the choices at all.
 */
function sendAmbiguousSource(
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  err: marketplace.AmbiguousSourceError,
): void {
  const body: MarketplaceAmbiguousSourceErrorBody = {
    error: err.message,
    code: "ambiguous-source",
    sourceIds: err.sourceIds,
  };
  res.status(409).json(body);
}

/**
 * The optional explicit source choice on an install/update body. A non-string (or
 * absent) value reads as "no choice", which is the ambiguity guard's input, not an
 * error: an unknown or non-serving id is rejected downstream by `assertInstallable`
 * against the sources that actually serve the plugin, so there is nothing to
 * validate here.
 */
function parseSourceId(body: unknown): string | undefined {
  const raw = (body as { sourceId?: unknown } | null | undefined)?.sourceId;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

router.get("/plugins", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const kind = parseKind(req.query.kind);
  // Scope the merged multi-source list to one source (the source filter chips,
  // issue #557). An unknown id simply matches no listings; there is nothing to
  // reject, since the id space is the registered sources the client just read off
  // this same response.
  const sourceId = typeof req.query.sourceId === "string" ? req.query.sourceId : undefined;
  try {
    const { listings, source, fetchedAt, sources } = await marketplace.listCatalog({
      q,
      kind,
      sourceId,
    });
    // Forward the first-party catalog's provenance so the client can render the
    // offline / staleness banner when the marketplace was unreachable (the
    // catalog degraded to cache/seed, source !== "network"; issue #372), plus the
    // per-source status of every source in the fan-out so a single dead source
    // renders as unavailable while the rest list normally (issue #557).
    const body: MarketplaceCatalogResponse = {
      curated: true,
      listings,
      source,
      fetchedAt,
      sources,
    };
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message, code: "internal" });
  }
});

router.post("/plugins/:id/install", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id", code: "invalid-input" });
    return;
  }
  try {
    if (!(await marketplace.resolveEntry(id))) {
      res.status(404).json({ error: `Unknown catalog plugin: ${id}`, code: "invalid-input" });
      return;
    }
    const preview = await marketplace.install(id, parseSourceId(req.body));
    res.status(200).json(preview);
  } catch (err) {
    if (err instanceof marketplace.AmbiguousSourceError) {
      sendAmbiguousSource(res, err);
      return;
    }
    sendInstallError(res, err);
  }
});

router.post("/plugins/:id/update", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id", code: "invalid-input" });
    return;
  }
  try {
    if (!(await marketplace.resolveEntry(id))) {
      res.status(404).json({ error: `Unknown catalog plugin: ${id}`, code: "invalid-input" });
      return;
    }
    const preview = await marketplace.update(id, parseSourceId(req.body));
    res.status(200).json(preview);
  } catch (err) {
    // Enforced at the UPDATE path too, not only install (CPHMTP-FR-005 AC3): an
    // installed plugin whose id a second source starts serving is ambiguous to
    // update, and the installed copy is left untouched until a source is named.
    if (err instanceof marketplace.AmbiguousSourceError) {
      sendAmbiguousSource(res, err);
      return;
    }
    sendInstallError(res, err);
  }
});

// Third-party marketplace source registry (issue #553; CPHMTP-FR-001,
// CPHMTP-FR-003, CPHMTP-NFR-002, CPHMTP-NFR-003).
//
//   GET    /api/marketplace/sources        list registered sources (+ built-in)
//   POST   /api/marketplace/sources        register a source (pure write)
//   DELETE /api/marketplace/sources/:id     remove a registered source
//
// POST is a PURE WRITE: the server validates the URL shape and persists the row
// plus optional keyring credential, but makes NO network call to the candidate URL
// (CPHMTP-NFR-003). The built-in first-party source is always listed and cannot be
// removed.

router.get("/sources", (_req, res) => {
  res.json({ sources: sourcesState.listSourceSummaries() });
});

router.post("/sources", async (req, res) => {
  const body = (req.body ?? {}) as {
    url?: unknown;
    credential?: unknown;
    allowHttp?: unknown;
  };
  try {
    const result = await sourcesState.addSource({
      url: body.url,
      credential: body.credential,
      allowHttp: body.allowHttp,
    });
    if (result.outcome === "invalid-url") {
      res.status(400).json({ error: "Invalid source URL", code: "invalid-url" });
      return;
    }
    if (result.outcome === "replaced") {
      // The URL is already registered: no second entry is created, but the
      // credential was replaced. Reject the duplicate registration with 409 while
      // returning the (updated) row (CPHMTP-FR-001 / issue #553 AC). The cached
      // client still holds the OLD credential, so drop it (issue #557).
      marketplace.invalidateSourceClient(result.source.id);
      res.status(409).json(result.source);
      return;
    }
    // A fresh registration can still resolve to an id that was cached earlier in
    // this process (removed and re-registered at the same URL yields the same
    // slug), so drop any client left over from that row.
    marketplace.invalidateSourceClient(result.source.id);
    res.status(201).json(result.source);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message, code: "internal" });
  }
});

router.delete("/sources/:id", async (req, res) => {
  try {
    const result = await sourcesState.removeSource(req.params.id);
    if (result === "first-party") {
      // The built-in first-party source cannot be removed.
      res
        .status(403)
        .json({ error: "The first-party source cannot be removed", code: "forbidden" });
      return;
    }
    if (result === "not-found") {
      res.status(404).json({ error: `Unknown source: ${req.params.id}`, code: "not-found" });
      return;
    }
    // The row is gone, so listCatalog stops asking for it, but the cached client
    // would outlive a same-URL re-registration (which resolves to the same id).
    marketplace.invalidateSourceClient(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message, code: "internal" });
  }
});

export default router;
