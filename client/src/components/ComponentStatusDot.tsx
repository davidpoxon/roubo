import type { ComponentStatusValue } from "@roubo/shared";

const colorMap: Record<ComponentStatusValue, string> = {
  running: "bg-green-500",
  starting: "bg-amber-500",
  stopping: "bg-amber-500",
  error: "bg-red-500",
  stopped: "bg-stone-300 dark:bg-stone-600",
  completed: "bg-green-500",
};

export default function ComponentStatusDot({
  status,
  label,
}: {
  status: ComponentStatusValue;
  label?: string;
}) {
  const isTransitional = status === "starting" || status === "stopping";

  return (
    <span
      title={label ? `${label}: ${status}` : status}
      className={`inline-block w-2 h-2 rounded-full ${colorMap[status]} ${
        isTransitional ? "animate-status-pulse" : ""
      } transition-colors duration-300`}
    />
  );
}
