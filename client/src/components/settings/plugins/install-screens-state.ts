import type { InstallPreview } from "@roubo/shared";

export type SourceTab = "git" | "local";

export interface SourceStep {
  step: "source";
  tab: SourceTab;
  gitInput: string;
  localInput: string;
  error: string | null;
}

export interface PermissionsStep {
  step: "permissions";
  preview: InstallPreview;
  error: string | null;
}

export function initialSourceStep(tab: SourceTab = "git"): SourceStep {
  return {
    step: "source",
    tab,
    gitInput: "",
    localInput: "",
    error: null,
  };
}
