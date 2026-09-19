import type { BenchNotification, NotificationPriority } from "@roubo/shared";
import { getHighestPriority } from "../lib/notifications";

const colorMap: Record<NotificationPriority, string> = {
  "action-needed": "bg-accent",
  info: "bg-text-secondary",
};

const labelMap: Record<NotificationPriority, string> = {
  "action-needed": "Action needed",
  info: "Notification",
};

export default function NotificationIndicator({
  notifications,
}: {
  notifications: BenchNotification[];
}) {
  const priority = getHighestPriority(notifications);
  if (priority === null) return null;

  return (
    <span
      role="img"
      aria-label={labelMap[priority]}
      className={`inline-block w-2 h-2 rounded-full ${colorMap[priority]} ${
        priority === "action-needed" ? "animate-status-pulse" : ""
      } transition-colors duration-300`}
    />
  );
}
