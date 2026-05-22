import { Router } from "express";
import * as pluginManager from "../services/plugin-manager.js";

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LOG_LINES = 5000;

function badId(id: string): boolean {
  return !PLUGIN_ID_RE.test(id);
}

function known(id: string): boolean {
  return pluginManager.listInstalled().some((r) => r.id === id);
}

router.get("/", (_req, res) => {
  res.json({
    hostApiVersion: pluginManager.HOST_API_VERSION,
    plugins: pluginManager.listInstalled(),
  });
});

router.post("/:id/enable", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.enable(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.post("/:id/disable", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.disable(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.post("/:id/restart", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }
  try {
    await pluginManager.restart(id);
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

router.get("/:id/logs", async (req, res) => {
  const id = req.params.id;
  if (badId(id)) {
    res.status(400).json({ error: "Invalid plugin id" });
    return;
  }
  if (!known(id)) {
    res.status(404).json({ error: `Unknown plugin: ${id}` });
    return;
  }

  const fileRaw = (req.query.file as string | undefined) ?? "current";
  if (fileRaw !== "current" && fileRaw !== "previous") {
    res.status(400).json({ error: "file must be 'current' or 'previous'" });
    return;
  }

  let lines = 500;
  if (req.query.lines !== undefined) {
    const parsed = Number(req.query.lines);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LOG_LINES) {
      res.status(400).json({ error: `lines must be a positive integer up to ${MAX_LOG_LINES}` });
      return;
    }
    lines = parsed;
  }

  try {
    const result = await pluginManager.readLogs(id, fileRaw, lines);
    res.json({ lines: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
