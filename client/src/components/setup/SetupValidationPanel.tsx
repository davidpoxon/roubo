import { Check, AlertCircle, Loader } from "lucide-react";
import { Button } from "react-aria-components";
import type { RouboConfig, ConfigValidationResult } from "@roubo/shared";
import {
  WIZARD_SECTIONS,
  SECTION_LABELS,
  validateSection,
  type WizardSection,
} from "./wizardReducer";
import type { SetupMode } from "./GuidedYamlToggle";

export type PortConflict = ConfigValidationResult["portConflicts"][number];

export type ValidationStatus = "idle" | "pending" | "valid" | "errors";

export interface ValidationError {
  path: string;
  message: string;
  line?: number;
}

interface Props {
  mode: SetupMode;
  config: Partial<RouboConfig>;
  conflicts: PortConflict[];
  saveError?: string;
  yamlStatus: ValidationStatus;
  yamlErrors: ValidationError[];
  lastCheckedAt?: Date;
  onValidate: () => void;
  isValidating: boolean;
}

function formatLastChecked(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  return `${Math.floor(diffSec / 60)}m ago`;
}

export default function SetupValidationPanel({
  mode,
  config,
  conflicts,
  saveError,
  yamlStatus,
  yamlErrors,
  lastCheckedAt,
  onValidate,
  isValidating,
}: Props) {
  const invalidSections =
    mode === "guided"
      ? WIZARD_SECTIONS.filter((s): s is WizardSection => validateSection(s, config) === "invalid")
      : [];

  const guidedIssueCount = invalidSections.length + conflicts.length + (saveError ? 1 : 0);

  const isGuidedValid = mode === "guided" && guidedIssueCount === 0;

  let guidedFirstMessage: string | null = null;
  if (invalidSections.length > 0) {
    guidedFirstMessage = `${SECTION_LABELS[invalidSections[0]]} is incomplete`;
  } else if (conflicts.length > 0) {
    guidedFirstMessage = `Port conflict on "${conflicts[0].port}"`;
  } else if (saveError) {
    guidedFirstMessage = saveError;
  }

  return (
    <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/30 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-600">
          Validation
        </div>
        <Button
          onPress={onValidate}
          isDisabled={isValidating}
          className="text-[10px] text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer transition-colors outline-none data-[focus-visible]:underline disabled:opacity-40 disabled:cursor-default flex items-center gap-1"
        >
          {isValidating ? <Loader size={9} className="animate-spin" /> : null}
          Check
        </Button>
      </div>

      {/* Guided mode: wizard section status */}
      {mode === "guided" && (
        <div className="mb-2">
          {isGuidedValid ? (
            <>
              <div className="flex items-center gap-2 text-[12px] text-green-600 dark:text-green-400">
                <Check size={12} />
                Valid
              </div>
              <div className="text-[11px] text-stone-400 dark:text-stone-600 mt-1.5">
                Ready to save.
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-[12px] text-red-500 dark:text-red-400 mb-1.5">
                <AlertCircle size={12} />
                {guidedIssueCount} {guidedIssueCount === 1 ? "issue" : "issues"}
              </div>
              {guidedFirstMessage && (
                <div className="text-[11px] text-red-500 dark:text-red-400 leading-snug">
                  {guidedFirstMessage}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Schema validation status (both modes: shown in YAML always; shown in Guided after first Check) */}
      {(mode === "yaml" || lastCheckedAt) && (
        <div
          className={
            mode === "guided" && lastCheckedAt
              ? "border-t border-stone-200 dark:border-stone-700 pt-2 mt-1"
              : ""
          }
        >
          {yamlStatus === "idle" && mode === "yaml" && (
            <p className="text-[11px] text-stone-400 dark:text-stone-600">
              Click Check to validate the schema.
            </p>
          )}

          {yamlStatus === "pending" && (
            <div className="flex items-center gap-2 text-[12px] text-stone-400 dark:text-stone-600">
              <Loader size={12} className="animate-spin" />
              Checking…
            </div>
          )}

          {yamlStatus === "valid" && (
            <>
              <div className="flex items-center gap-2 text-[12px] text-green-600 dark:text-green-400">
                <Check size={12} />
                Schema valid
              </div>
              {lastCheckedAt && (
                <div className="text-[11px] text-stone-400 dark:text-stone-600 mt-1.5">
                  Last checked: {formatLastChecked(lastCheckedAt)}
                </div>
              )}
            </>
          )}

          {yamlStatus === "errors" && (
            <>
              <div className="flex items-center gap-1.5 text-[12px] text-red-500 dark:text-red-400 mb-2">
                <AlertCircle size={12} />
                {yamlErrors.length} schema {yamlErrors.length === 1 ? "error" : "errors"}
              </div>
              <div className="space-y-1">
                {yamlErrors.map((err, i) => (
                  <div
                    key={i}
                    className="text-[11px] font-mono text-red-500 dark:text-red-400 leading-snug"
                  >
                    {err.line != null && (
                      <span className="text-stone-400 dark:text-stone-600">
                        roubo.yaml:{err.line}{" "}
                      </span>
                    )}
                    <span>
                      {err.path}: {err.message}
                    </span>
                  </div>
                ))}
              </div>
              {lastCheckedAt && (
                <div className="text-[11px] text-stone-400 dark:text-stone-600 mt-2">
                  Last checked: {formatLastChecked(lastCheckedAt)}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* YAML mode extra: port conflicts and save error */}
      {mode === "yaml" && (conflicts.length > 0 || saveError) && (
        <div className="border-t border-stone-200 dark:border-stone-700 pt-2 mt-2 space-y-1.5">
          {conflicts.map((c, i) => (
            <div key={i} className="text-[11px] text-amber-600 dark:text-amber-400">
              Port conflict on "{c.port}"
            </div>
          ))}
          {saveError && (
            <div className="text-[11px] text-red-500 dark:text-red-400 leading-snug">
              {saveError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
