import type {
  Bench,
  BenchNotification,
  NotificationType,
  NotificationPriority,
} from "@roubo/shared";

export function getHighestPriority(
  notifications: BenchNotification[],
): NotificationPriority | null {
  if (notifications.length === 0) return null;
  if (notifications.some((n) => n.priority === "action-needed")) return "action-needed";
  if (notifications.some((n) => n.priority === "info")) return "info";
  return null;
}

export function hasActionNeeded(notifications: BenchNotification[]): boolean {
  return notifications.some((n) => n.priority === "action-needed");
}

export function collectActionNeeded(benches: Bench[]): BenchNotification[] {
  return benches.flatMap((b) => b.notifications.filter((n) => n.priority === "action-needed"));
}

// Every entry names no specific product (see docs/brand.md): any agent plugin's
// session raises these, and core has known nothing about a particular agent
// since #521.
const notificationMessages: Record<NotificationType, { title: string; body: string }> = {
  "agent-waiting": {
    title: "Agent needs input",
    body: "An AI coding agent session is waiting for your response",
  },
  "terminal-waiting": {
    title: "Terminal needs attention",
    body: "A terminal session is waiting for input",
  },
  "bench-error": {
    title: "Bench error",
    body: "A bench has encountered an error",
  },
  "component-error": {
    title: "Component error",
    body: "A component has encountered an error",
  },
  "agent-exited": {
    title: "Agent exited",
    body: "An agent session has ended",
  },
  "bench-ready": { title: "Bench ready", body: "A bench is ready to use" },
  "inspection-complete": {
    title: "Inspection complete",
    body: "An inspection run has finished",
  },
};

export function formatNotification(notification: BenchNotification): {
  title: string;
  body: string;
} {
  return notificationMessages[notification.type] ?? { title: "Notification", body: "" };
}
