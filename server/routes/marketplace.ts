import { Router } from "express";
import type {
  InstallErrorCode,
  MarketplaceCatalogErrorBody,
  MarketplaceCatalogResponse,
  MarketplaceKind,
} from "@roubo/shared";
import * as marketplace from "../services/marketplace.js";
import * as pluginInstaller from "../services/plugin-installer.js";
import { CatalogUnverifiedError } from "../services/catalog-client.js";

// Marketplace routes (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621;
// CP-FR-021 / CP-US-011, issue #622).
//
//   GET  /api/marketplace/plugins?q=&kind=   curated catalog, annotated
//   POST /api/marketplace/plugins/:id/install  -> InstallPreview (staging token)
//   POST /api/marketplace/plugins/:id/update   -> InstallPreview (staging token)
//
// Install/update return a staging token; the client drives the existing
// `/api/plugins/install/:token/confirm` and `/cancel` endpoints for the commit
// step (the same consent flow component installs already use). There is no
// third-party submission route here: the catalog is first-party curated only.
//
// Channel integrity (issue #622) + hosted catalog (issue #306): the catalog is
// fetched + verified per request via the catalog-client, which degrades
// NETWORK -> CACHE -> SEED so the listing is never zero. GET /plugins surfaces a
// typed catalog-unverified error (502) only when even the bundled seed fails
// verification (CatalogUnverifiedError); otherwise it always serves a verified
// catalog. Install/update map integrity-failed (422), revoked (410), and the new
// marketplace-unreachable (503, the catalog is degraded to cache/seed) codes.

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
    // the same unprocessable-content class (#370).
    case "integrity-failed":
    case "unpack-failed":
      return 422;
    // The marketplace is unreachable (catalog served from cache/seed), so a new
    // install/update is paused: 503 Service Unavailable.
    case "marketplace-unreachable":
      return 503;
    // An unverified catalog should never reach an install/update (those reject
    // on the empty catalog first), but map it defensively to 502 Bad Gateway.
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

function sendCatalogUnverified(res: Parameters<Parameters<typeof router.get>[1]>[1]): void {
  // Fail closed: even the bundled seed failed verification, so surface a typed
  // catalog-unverified error (502) with no listings (CP-TC-118, CPHM-TC-006).
  const body: MarketplaceCatalogErrorBody = {
    error: "The plugin catalog could not be verified and was rejected.",
    code: "catalog-unverified",
  };
  res.status(502).json(body);
}

router.get("/plugins", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const kind = parseKind(req.query.kind);
  try {
    const { listings, source, fetchedAt } = await marketplace.listCatalog({ q, kind });
    // Forward the served catalog's provenance so the client can render the
    // offline / staleness banner when the marketplace was unreachable (the
    // catalog degraded to cache/seed, source !== "network"; issue #372).
    const body: MarketplaceCatalogResponse = { curated: true, listings, source, fetchedAt };
    res.json(body);
  } catch (err) {
    if (err instanceof CatalogUnverifiedError) {
      sendCatalogUnverified(res);
      return;
    }
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
    const preview = await marketplace.install(id);
    res.status(200).json(preview);
  } catch (err) {
    if (err instanceof CatalogUnverifiedError) {
      sendCatalogUnverified(res);
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
    const preview = await marketplace.update(id);
    res.status(200).json(preview);
  } catch (err) {
    if (err instanceof CatalogUnverifiedError) {
      sendCatalogUnverified(res);
      return;
    }
    sendInstallError(res, err);
  }
});

export default router;
