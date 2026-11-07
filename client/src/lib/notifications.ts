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
// since #1114.
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
  "agent-exited-unexpectedly": {
    title: "Agent ended unexpectedly",
    body: "An AI coding agent session was killed or exited with an error",
  },
  "bench-ready": { title: "Bench ready", body: "A bench is ready to use" },
  "agent-launch-failed": {
    title: "Agent did not start",
    body: "A bench was created but its agent session never opened",
  },
  "agent-fallback": {
    title: "Agent changed",
    body: "The configured default agent was unavailable, so a different one was used",
  },
  "delivery-jam": {
    title: "Delivery unit jammed",
    body: "A unit of a Spec Bench delivery is stuck and waits for you",
  },
  "delivery-decision": {
    title: "Delivery decision",
    body: "The delivery session of a Spec Bench asks you to decide",
  },
  "delivery-crosscheck": {
    title: "Delivery cross-check",
    body: "The delivery record of a Spec Bench disagrees with what it delivers",
  },
};

export function formatNotification(notification: BenchNotification): {
  title: string;
  body: string;
} {
  // A blocking cross-check class names the class (SB-FR-030).
  const crossCheckClass = notification.metadata?.class;
  if (
    notification.type === "delivery-crosscheck" &&
    typeof crossCheckClass === "string" &&
    crossCheckClass.length > 0
  ) {
    return {
      title: notificationMessages["delivery-crosscheck"].title,
      body: `The delivery record disagrees with its source: ${crossCheckClass}`,
    };
  }
  const unitId = notification.metadata?.unitId;
  if (notification.type === "delivery-jam" && typeof unitId === "string" && unitId.length > 0) {
    return {
      title: notificationMessages["delivery-jam"].title,
      body: `Unit ${unitId} of the delivery is jammed and waits for you`,
    };
  }
  // A review call (SB-FR-034) is composed from its count alone: no text the
  // session wrote reaches it (SB-NFR-009).
  const count = notification.metadata?.count;
  if (
    notification.type === "delivery-decision" &&
    notification.metadata?.review === true &&
    typeof count === "number"
  ) {
    return {
      title: "Delivery review",
      body:
        count === 1
          ? "1 agent decision waits for your review"
          : `${count} agent decisions wait for your review`,
    };
  }
  // A decision's notification names the decision by its id in the title and
  // asks its question in the body (SB-FR-014).
  const question = notification.metadata?.question;
  if (
    notification.type === "delivery-decision" &&
    typeof question === "string" &&
    question.length > 0
  ) {
    const decisionId = notification.metadata?.decisionId;
    const title = notificationMessages["delivery-decision"].title;
    return {
      title:
        typeof decisionId === "string" && decisionId.length > 0 ? `${title} ${decisionId}` : title,
      body: question,
    };
  }
  return notificationMessages[notification.type] ?? { title: "Notification", body: "" };
}

/**
 * Where a notification leads when it is clicked: the bench, or for a
 * delivery-decision notification the bench's decision pile (SB-FR-014), where
 * the decision, or the review call's cards, wait for the operator.
 */
export function notificationRouteTo(
  projectId: string,
  benchId: number,
  notification: BenchNotification,
): string {
  const bench = `roubo://project/${projectId}/bench/${String(benchId)}`;
  return notification.type === "delivery-decision" ? `${bench}/decisions` : bench;
}
