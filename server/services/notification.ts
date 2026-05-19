import { randomUUID } from "node:crypto";
import type {
  Bench,
  BenchNotification,
  NotificationPriority,
  NotificationType,
} from "@roubo/shared";
import * as stateService from "./state.js";
import * as sseService from "./sse.js";

// Notification types that represent "session is idle, waiting for user input".
// Cleared on fresh PTY output; sticky session-scoped types (claude-exited)
// deliberately not in this set.
export const WAITING_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  "terminal-waiting",
  "claude-waiting",
]);

function derivePriority(type: NotificationType): NotificationPriority {
  switch (type) {
    case "claude-waiting":
    case "terminal-waiting":
    case "bench-error":
    case "component-error":
    case "teardown-blocked":
    case "sync-error":
    case "claude-exited":
      return "action-needed";
    case "bench-ready":
    case "inspection-complete":
      return "info";
  }
}

function persistBench(bench: Bench): void {
  stateService.updateBench({
    id: bench.id,
    projectId: bench.projectId,
    branch: bench.branch,
    workspacePath: bench.workspacePath,
    ports: bench.ports,
    createdAt: bench.createdAt,
    assignedContainers: bench.assignedContainers,
    assignedIssue: bench.assignedIssue,
    notifications: bench.notifications,
    workUnits: bench.workUnits,
    baseBranch: bench.baseBranch,
    baseCommit: bench.baseCommit,
    injectedBlueprintId: bench.injectedBlueprintId,
    injectedBlueprintSource: bench.injectedBlueprintSource,
  });
}

export function createNotification(
  bench: Bench,
  type: NotificationType,
  sourceSessionId?: string,
  metadata?: Record<string, unknown>,
): BenchNotification {
  const existing = bench.notifications.find(
    (n) => n.type === type && n.sourceSessionId === sourceSessionId,
  );
  if (existing) {
    if (metadata) existing.metadata = metadata;
    return existing;
  }

  const notification: BenchNotification = {
    id: randomUUID(),
    type,
    priority: derivePriority(type),
    sourceSessionId,
    metadata,
    createdAt: new Date().toISOString(),
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
  // teardown-blocked must persist until the user explicitly dismisses it (dismissOne),
  // not be silently cleared on bench open.
  bench.notifications = bench.notifications.filter(
    (n) => n.sourceSessionId || n.type === "teardown-blocked",
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

// Dismiss only the "waiting for input" notifications for a session — used when
// fresh PTY output proves the session is no longer idle. Narrower than
// dismissBySession so we don't silently clear sticky session-scoped notifs
// like claude-exited. Safe to call when there's no match (returns false
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

export function dismissSyncErrorForWorkUnit(bench: Bench, submodule: string): void {
  const sourceSessionId = `sync-error::${submodule}`;
  const before = bench.notifications.length;
  bench.notifications = bench.notifications.filter(
    (n) => !(n.type === "sync-error" && n.sourceSessionId === sourceSessionId),
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

export function getNotifications(bench: Bench): BenchNotification[] {
  return [...bench.notifications];
}
