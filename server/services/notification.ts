import { randomUUID } from "node:crypto";
import type {
  AgentLaunchFailure,
  Bench,
  BenchNotification,
  NotificationPriority,
  NotificationType,
  SessionUnexpectedExit,
} from "@roubo/shared";
import * as benchManager from "./bench-manager.js";
import * as stateService from "./state.js";
import * as sseService from "./sse.js";
import { redactSecrets } from "./log-redaction.js";

// Notification types that represent "session is idle, waiting for user input".
// Cleared on fresh PTY output; the sticky session-scoped `agent-exited` is
// deliberately not in this set.
export const WAITING_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  "terminal-waiting",
  "agent-waiting",
]);

// Bench-level notification types that survive dismissBenchLevelForBench (AP-NFR-003,
// TODO: cite tracking issue once filed). A failed auto-launch, and a launch that fell
// back to an agent other than the configured default, have to stay visible until the
// user explicitly dismisses them; opening the bench must not clear them the way an
// ordinary bench-level notice is cleared.
const STICKY_BENCH_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  "agent-launch-failed",
  "agent-fallback",
]);

function derivePriority(type: NotificationType): NotificationPriority {
  switch (type) {
    case "agent-waiting":
    case "terminal-waiting":
    case "bench-error":
    case "component-error":
    case "agent-exited":
    case "agent-exited-unexpectedly":
    case "agent-launch-failed":
      return "action-needed";
    case "bench-ready":
    case "agent-fallback":
      return "info";
  }
}

function persistBench(bench: Bench): void {
  // Notifications fire from live PTY streams and component lifecycle tails, so
  // this runs long after the caller captured its `bench` reference. Skip the
  // write once teardown has dropped the bench from the in-memory map, matching
  // the guard issue-assignment applies to its own background writes (#1191).
  // `updateBench` is a no-op for an absent record anyway; this just avoids the
  // pointless load/save.
  if (!benchManager.isBenchLive(bench.projectId, bench.id)) return;
  // updateBench replaces the whole record, so persist through the one complete
  // projection: a hand-listed subset here erased every field it forgot (variant,
  // focusedSpecPath, componentSetupState, componentUrls, and before #997
  // benchSetupComplete) on the next notification write.
  stateService.updateBench(stateService.toPersistedBench(bench));
}

export function createNotification(
  bench: Bench,
  type: NotificationType,
  sourceSessionId?: string,
  metadata?: Record<string, unknown>,
  launchFailure?: AgentLaunchFailure,
  unexpectedExit?: SessionUnexpectedExit,
): BenchNotification {
  // `capturedOutput` is raw PTY bytes about to be persisted to state.json, so it
  // gets the same redaction plugin logs already apply (log-redaction.ts).
  const redactedFailure =
    launchFailure?.capturedOutput !== undefined
      ? { ...launchFailure, capturedOutput: redactSecrets(launchFailure.capturedOutput) }
      : launchFailure;

  const existing = bench.notifications.find(
    (n) => n.type === type && n.sourceSessionId === sourceSessionId,
  );
  if (existing) {
    // A repeat that carries a payload replaces the whole payload, so a later
    // failure with only a message does not keep showing an earlier failure's
    // structured guidance. It persists and broadcasts only when the payload
    // actually differs: agent-waiting repeats on every idle tick with the same
    // label, and must not turn each tick into a state.json write.
    if (metadata === undefined && redactedFailure === undefined && unexpectedExit === undefined) {
      return existing;
    }
    const changed =
      JSON.stringify(existing.metadata) !== JSON.stringify(metadata) ||
      JSON.stringify(existing.launchFailure) !== JSON.stringify(redactedFailure) ||
      JSON.stringify(existing.unexpectedExit) !== JSON.stringify(unexpectedExit);
    existing.metadata = metadata;
    existing.launchFailure = redactedFailure;
    existing.unexpectedExit = unexpectedExit;
    if (changed) {
      persistBench(bench);
      sseService.broadcast({
        type: "notifications",
        projectId: bench.projectId,
        benchId: bench.id,
        notifications: bench.notifications,
      });
    }
    return existing;
  }

  const notification: BenchNotification = {
    id: randomUUID(),
    type,
    priority: derivePriority(type),
    sourceSessionId,
    metadata,
    createdAt: new Date().toISOString(),
    launchFailure: redactedFailure,
    unexpectedExit,
  };
  bench.notifications.push(notification);
  persistBench(bench);
  sseService.broadcast({
    type: "notifications",
    projectId: bench.projectId,
    benchId: bench.id,
    notifications: bench.notifications,
  });
  return notification;
}

export function dismissBenchLevelForBench(bench: Bench): void {
  const before = bench.notifications.length;
  bench.notifications = bench.notifications.filter(
    (n) => n.sourceSessionId || STICKY_BENCH_NOTIFICATION_TYPES.has(n.type),
  );
  if (bench.notifications.length !== before) {
    persistBench(bench);
    sseService.broadcast({
      type: "notifications",
      projectId: bench.projectId,
      benchId: bench.id,
      notifications: bench.notifications,
    });
  }
}

export function dismissOne(bench: Bench, notificationId: string): void {
  const before = bench.notifications.length;
  bench.notifications = bench.notifications.filter((n) => n.id !== notificationId);
  if (bench.notifications.length !== before) {
    persistBench(bench);
    sseService.broadcast({
      type: "notifications",
      projectId: bench.projectId,
      benchId: bench.id,
      notifications: bench.notifications,
    });
  }
}

export function dismissBySession(bench: Bench, sessionId: string): void {
  const before = bench.notifications.length;
  bench.notifications = bench.notifications.filter((n) => n.sourceSessionId !== sessionId);
  if (bench.notifications.length !== before) {
    persistBench(bench);
    sseService.broadcast({
      type: "notifications",
      projectId: bench.projectId,
      benchId: bench.id,
      notifications: bench.notifications,
    });
  }
}

// Dismiss only the "waiting for input" notifications for a session: used when
// fresh PTY output proves the session is no longer idle. Narrower than
// dismissBySession so we don't silently clear sticky session-scoped notifs
// like agent-exited. Safe to call when there's no match (returns false
// without persisting or broadcasting); callers may pre-check to skip the
// filter allocation on the hot path.
export function dismissWaitingForSession(bench: Bench, sessionId: string): boolean {
  const before = bench.notifications.length;
  bench.notifications = bench.notifications.filter(
    (n) => !(n.sourceSessionId === sessionId && WAITING_NOTIFICATION_TYPES.has(n.type)),
  );
  if (bench.notifications.length === before) return false;
  persistBench(bench);
  sseService.broadcast({
    type: "notifications",
    projectId: bench.projectId,
    benchId: bench.id,
    notifications: bench.notifications,
  });
  return true;
}

export function getNotifications(bench: Bench): BenchNotification[] {
  return [...bench.notifications];
}
