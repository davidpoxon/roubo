import { Router } from "express";
import type { InstallErrorCode, MarketplaceCatalogResponse, MarketplaceKind } from "@roubo/shared";
import * as marketplace from "../services/marketplace.js";
import * as pluginInstaller from "../services/plugin-installer.js";

// Marketplace routes (CP-FR-020 / CP-NFR-007 / CP-US-010, issue #621).
//
//   GET  /api/marketplace/plugins?q=&kind=   curated catalog, annotated
//   POST /api/marketplace/plugins/:id/install  -> InstallPreview (staging token)
//   POST /api/marketplace/plugins/:id/update   -> InstallPreview (staging token)
//
// Install/update return a staging token; the client drives the existing
// `/api/plugins/install/:token/confirm` and `/cancel` endpoints for the commit
// step (the same consent flow component installs already use). There is no
// third-party submission route here: the catalog is first-party curated only.

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;

function badId(id: string): boolean {
  return !PLUGIN_ID_RE.test(id);
}

function installErrorStatus(code: InstallErrorCode): number {
  switch (code) {
    case "invalid-input":
    case "clone-failed":
    case "missing-manifest":
    case "invalid-manifest":
    case "incompatible-host":
      return 400;
    case "duplicate-id":
      return 409;
    case "unknown-token":
    case "update-target-missing":
      return 404;
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

router.get("/plugins", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const kind = parseKind(req.query.kind);
  const listings = marketplace.listCatalog({ q, kind });
  const body: MarketplaceCatalogResponse = { curated: true, listings };
  res.json(body);
});

router.post("/plugins/:id/install", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id", code: "invalid-input" });
    return;
  }
  if (!marketplace.resolveEntry(id)) {
    res.status(404).json({ error: `Unknown catalog plugin: ${id}`, code: "invalid-input" });
    return;
  }
  try {
    const preview = await marketplace.install(id);
    res.status(200).json(preview);
  } catch (err) {
    sendInstallError(res, err);
  }
});

router.post("/plugins/:id/update", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id", code: "invalid-input" });
    return;
  }
  if (!marketplace.resolveEntry(id)) {
    res.status(404).json({ error: `Unknown catalog plugin: ${id}`, code: "invalid-input" });
    return;
  }
  try {
    const preview = await marketplace.update(id);
    res.status(200).json(preview);
  } catch (err) {
    sendInstallError(res, err);
  }
});

export default router;
