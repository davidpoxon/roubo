import type { BenchNotification, NotificationPriority } from "@roubo/shared";
import { getHighestPriority } from "../lib/notifications";

const colorMap: Record<NotificationPriority, string> = {
  "action-needed": "bg-amber-500",
  info: "bg-stone-400 dark:bg-stone-500",
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
