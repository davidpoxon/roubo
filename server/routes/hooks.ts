import { Router } from "express";
import * as terminalService from "../services/terminal.js";
import * as notificationService from "../services/notification.js";
import * as benchManager from "../services/bench-manager.js";

const router = Router();

// The endpoint every `http-hook` agent descriptor POSTs its waiting events to.
// The path is a stable published contract that shipped plugin manifests already
// carry, so it keeps its name; nothing about the handler is agent-specific.
router.post("/claude-notification", (req, res) => {
  const { session_id } = req.body as { session_id?: unknown };

  if (!session_id || typeof session_id !== "string") {
    res.status(400).json({ error: "Missing or invalid session_id" });
    return;
  }

  const session = terminalService.getSession(session_id);
  if (!session) {
    // `session_id` is request-controlled, so it is passed as a console argument
    // rather than interpolated into the format string (js/tainted-format-string).
    console.warn("[hooks] rejected notification for unknown session %s", session_id);
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Agent-generic correlation (AP-FR-013): eligibility is the session's own
  // live-and-hook-wired state, not the name of the command it runs. This is
  // what rejects a forged or expired token: an exited session, or one restored
  // from disk after a restart, is still addressable by id but is no longer live
  // (AP-TC-084).
  if (!terminalService.isHookNotificationEligible(session_id)) {
    console.warn(
      "[hooks] rejected notification for session %s: not a live hook-wired agent session",
      session_id,
    );
    res.status(400).json({ error: "Session is not a live hook-wired agent session" });
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
    notificationService.createNotification(bench, "agent-waiting", session_id);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.json({ status: "ok" });
});

/**
 * The receiving end of the `spawned-notifier` notification wiring (issue #698).
 *
 * One agent-generic endpoint rather than a route per agent: the body carries a
 * correlation token, core trades it for the session that registered it at
 * launch, and nothing here knows which agent spawned the notifier. `payload` is
 * the event JSON the agent appended to the notifier's argv; it is accepted and
 * ignored, exactly as the handler above ignores the hook's own event fields,
 * because the signal is the arrival, not the contents.
 *
 * Unauthenticated for the same reason its sibling is: the live correlation token
 * is the bearer, and it is spent the moment the session's PTY exits.
 */
router.post("/agent-notification", (req, res) => {
  const { token } = req.body as { token?: unknown };

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Missing or invalid token" });
    return;
  }

  const session = terminalService.resolveNotifierSession(token);
  if (!session) {
    // The token is request-controlled, so it is passed as a console argument
    // rather than interpolated into the format string (js/tainted-format-string).
    console.warn("[hooks] rejected notification for unknown correlation token %s", token);
    res.status(404).json({ error: "Correlation token not found" });
    return;
  }

  if (!terminalService.isNotifierNotificationEligible(token)) {
    console.warn(
      "[hooks] rejected notification for token %s: not a live notifier-wired agent session",
      token,
    );
    res.status(400).json({ error: "Token does not name a live notifier-wired agent session" });
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
    // A turn-complete event is the agent handing control back, which is the same
    // user-facing state a waiting hook reports, so it reuses that notification
    // type rather than minting one the client has no rendering for.
    notificationService.createNotification(bench, "agent-waiting", session.id);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.json({ status: "ok" });
});

export default router;
