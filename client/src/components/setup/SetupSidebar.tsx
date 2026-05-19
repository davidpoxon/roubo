import { useEffect, useState } from "react";
import type { RouboConfig, Bench } from "@roubo/shared";
import type { SetupMode } from "./GuidedYamlToggle";
import SetupValidationPanel, {
  type PortConflict,
  type ValidationStatus,
  type ValidationError,
} from "./SetupValidationPanel";
import GuidedSummaryPanel from "./GuidedSummaryPanel";
import YamlImpactPanel from "./YamlImpactPanel";
import YamlOutlinePanel from "./YamlOutlinePanel";
import type { ImpactResult } from "./computeImpact";

export type { PortConflict };

interface Props {
  mode: SetupMode;
  config: Partial<RouboConfig>;
  portConflicts: PortConflict[];
  saveError?: string;
  rawYaml: string;
  onOutlineSectionClick: (key: string, line: number) => void;
  yamlStatus: ValidationStatus;
  yamlErrors: ValidationError[];
  lastCheckedAt?: Date;
  onValidate: () => void;
  isValidating: boolean;
  impact: ImpactResult | null;
  benches?: Bench[];
}

function OutlineMount({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={`transition-all duration-200 ease-out ${mounted ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"}`}
    >
      {children}
    </div>
  );
}

export default function SetupSidebar({
  mode,
  config,
  portConflicts,
  saveError,
  rawYaml,
  onOutlineSectionClick,
  yamlStatus,
  yamlErrors,
  lastCheckedAt,
  onValidate,
  isValidating,
  impact,
  benches,
}: Props) {
  return (
    <div className="space-y-4">
      {mode === "yaml" && (
        <OutlineMount>
          <YamlOutlinePanel rawYaml={rawYaml} onSectionClick={onOutlineSectionClick} />
        </OutlineMount>
      )}
      <SetupValidationPanel
        mode={mode}
        config={config}
        conflicts={portConflicts}
        saveError={saveError}
        yamlStatus={yamlStatus}
        yamlErrors={yamlErrors}
        lastCheckedAt={lastCheckedAt}
        onValidate={onValidate}
        isValidating={isValidating}
      />
      <GuidedSummaryPanel config={config} />
      <YamlImpactPanel impact={impact} totalBenches={benches?.length} />
    </div>
  );
}
