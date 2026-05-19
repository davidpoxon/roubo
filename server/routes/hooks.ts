import { Router } from "express";
import * as terminalService from "../services/terminal.js";
import * as notificationService from "../services/notification.js";
import * as benchManager from "../services/bench-manager.js";

const router = Router();

router.post("/claude-notification", (req, res) => {
  const { session_id } = req.body as { session_id?: unknown };

  if (!session_id || typeof session_id !== "string") {
    res.status(400).json({ error: "Missing or invalid session_id" });
    return;
  }

  const session = terminalService.getSession(session_id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (session.command !== "claude") {
    res.status(400).json({ error: "Session is not a Claude session" });
    return;
  }

  const parsed = terminalService.parseBenchKey(session.benchKey);
  if (!parsed) {
    res.status(500).json({ error: "Invalid bench key format" });
    return;
  }

  const bench = benchManager.getBench(parsed.projectId, parsed.benchId);
  if (!bench) {
    res.status(404).json({ error: "Bench not found" });
    return;
  }

  try {
    notificationService.createNotification(bench, "claude-waiting", session_id);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.json({ status: "ok" });
});

export default router;
