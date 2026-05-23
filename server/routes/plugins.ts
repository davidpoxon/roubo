import { Router } from "express";
import type { InstallErrorCode } from "@roubo/shared";
import * as pluginManager from "../services/plugin-manager.js";
import * as pluginInstaller from "../services/plugin-installer.js";

const router = Router();

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LOG_LINES = 5000;

function badId(id: string): boolean {
  return !PLUGIN_ID_RE.test(id);
}

function known(id: string): boolean {
  return pluginManager.listInstalled().some((r) => r.id === id);
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

router.get("/", (_req, res) => {
  res.json({
    hostApiVersion: pluginManager.HOST_API_VERSION,
    plugins: pluginManager.listInstalled(),
  });
});

router.post("/install", async (req, res) => {
  const body = (req.body ?? {}) as { source?: unknown; value?: unknown };
  if (body.source !== "git" && body.source !== "local") {
    res.status(400).json({
      error: "source must be 'git' or 'local'",
      code: "invalid-input",
    });
    return;
  }
  if (typeof body.value !== "string" || body.value.trim().length === 0) {
    res.status(400).json({ error: "value must be a non-empty string", code: "invalid-input" });
    return;
  }
  try {
    const preview =
      body.source === "git"
        ? await pluginInstaller.previewFromGitUrl(body.value)
        : await pluginInstaller.previewFromLocalPath(body.value);
    res.status(200).json(preview);
  } catch (err) {
    sendInstallError(res, err);
  }
});

router.post("/install/:token/confirm", async (req, res) => {
  const token = req.params.token;
  if (!pluginInstaller.isValidStagingToken(token)) {
    res.status(400).json({ error: "Invalid staging token", code: "invalid-input" });
    return;
  }
  try {
    const plugin = await pluginInstaller.commit(token);
    res.status(201).json({ plugin });
  } catch (err) {
    sendInstallError(res, err);
  }
});

router.post("/install/:token/cancel", async (req, res) => {
  const token = req.params.token;
  if (!pluginInstaller.isValidStagingToken(token)) {
    res.status(400).json({ error: "Invalid staging token", code: "invalid-input" });
    return;
  }
  try {
    await pluginInstaller.cancel(token);
    res.status(204).end();
  } catch (err) {
    sendInstallError(res, err);
  }
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

router.delete("/:id", async (req, res) => {
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
    await pluginManager.uninstall(id);
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
