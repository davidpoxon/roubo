import { Check, Loader2, X, Circle } from "lucide-react";
import type { ProvisioningStepStatus, ComponentPhaseStatus } from "@roubo/shared";

export const stepIcon: Record<ProvisioningStepStatus, React.ReactNode> = {
  done: <Check size={12} className="text-green-500" />,
  running: <Loader2 size={12} className="text-amber-500 animate-spin" />,
  error: <X size={12} className="text-red-500" />,
  pending: <Circle size={10} className="text-stone-300 dark:text-stone-700" />,
  cancelled: <X size={12} className="text-stone-500" />,
};

export const stepTextColor: Record<ProvisioningStepStatus, string> = {
  done: "text-stone-500",
  running: "text-stone-700 dark:text-stone-300",
  error: "text-red-400",
  pending: "text-stone-300 dark:text-stone-700",
  cancelled: "text-stone-400 dark:text-stone-600",
};

export const phaseIcon: Record<ComponentPhaseStatus, React.ReactNode> = {
  done: <Check size={10} className="text-green-500" />,
  running: <Loader2 size={10} className="text-amber-500 animate-spin" />,
  error: <X size={10} className="text-red-500" />,
  pending: <Circle size={8} className="text-stone-300 dark:text-stone-700" />,
};

export const phaseTextColor: Record<ComponentPhaseStatus, string> = {
  done: "text-stone-400 dark:text-stone-600",
  running: "text-amber-500/70",
  error: "text-red-400",
  pending: "text-stone-300 dark:text-stone-700",
};
