import { Check, Loader2, X, Circle } from "lucide-react";
import type { ProvisioningStepStatus, ComponentPhaseStatus } from "@roubo/shared";

export const stepIcon: Record<ProvisioningStepStatus, React.ReactNode> = {
  done: <Check size={12} className="text-status-active" />,
  running: <Loader2 size={12} className="text-status-preparing animate-spin" />,
  error: <X size={12} className="text-status-error" />,
  pending: <Circle size={12} className="text-status-idle" />,
  cancelled: <X size={12} className="text-text-secondary" />,
};

export const stepTextColor: Record<ProvisioningStepStatus, string> = {
  done: "text-text-secondary",
  running: "text-text-body",
  error: "text-danger-text",
  pending: "text-text-secondary",
  cancelled: "text-text-secondary",
};

export const phaseIcon: Record<ComponentPhaseStatus, React.ReactNode> = {
  done: <Check size={12} className="text-status-active" />,
  running: <Loader2 size={12} className="text-status-preparing animate-spin" />,
  error: <X size={12} className="text-status-error" />,
  pending: <Circle size={12} className="text-status-idle" />,
};

export const phaseTextColor: Record<ComponentPhaseStatus, string> = {
  done: "text-text-secondary",
  running: "text-text-body",
  error: "text-danger-text",
  pending: "text-text-secondary",
};
