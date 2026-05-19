import { RadioGroup } from "react-aria-components";
import { GitPullRequest } from "lucide-react";
import { DEFAULT_BENCH_SETTINGS } from "@roubo/shared";
import { useSettings } from "../../hooks/useSettings";
import Tile from "../settings/Tile";
import { BlueprintPickerOption } from "../ProjectDefaultBlueprintTile";
import { OverrideBadge } from "../settings/OverrideBadge";

type OverrideValue = "inherit" | "on" | "off";

function toRadioValue(val: boolean | null): OverrideValue {
  if (val === true) return "on";
  if (val === false) return "off";
  return "inherit";
}

function fromRadioValue(val: OverrideValue): boolean | null {
  if (val === "on") return true;
  if (val === "off") return false;
  return null;
}

export function WorkUnitAutoClearOverrideTile({
  draft,
  onChange,
}: {
  draft: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const { settings } = useSettings();
  const appDefault =
    settings?.benches?.workUnitAutoClear ?? DEFAULT_BENCH_SETTINGS.workUnitAutoClear;

  const isOverridden = draft !== null;
  const selectedValue = toRadioValue(draft);
  const effectiveValue = draft ?? appDefault;

  return (
    <Tile
      icon={<GitPullRequest aria-hidden="true" size={14} />}
      title="Auto-clear meta-repo benches by PR status"
      ariaLabel="Auto-clear meta-repo benches by PR status override"
      data-testid="work-unit-auto-clear-tile"
      isOverridden={isOverridden}
      headerAction={isOverridden ? <OverrideBadge /> : undefined}
    >
      {isOverridden && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-stone-400 dark:text-stone-600">Effective:</span>
          <span className="text-xs font-medium text-amber-500 dark:text-amber-400">
            {effectiveValue ? "On" : "Off"}
          </span>
        </div>
      )}

      <RadioGroup
        value={selectedValue}
        onChange={(val) => onChange(fromRadioValue(val as OverrideValue))}
        aria-label="Auto-clear meta-repo benches by PR status override"
        className="flex flex-col gap-2"
      >
        <BlueprintPickerOption
          value="inherit"
          label="Use app default"
          sublabel={`App default: ${appDefault ? "on" : "off"}`}
        />
        <BlueprintPickerOption value="on" label="Force on" />
        <BlueprintPickerOption value="off" label="Force off" />
      </RadioGroup>

      <p className="text-[11px] text-stone-400 dark:text-stone-600 mt-3 leading-relaxed">
        Changes write to{" "}
        <span className="font-mono text-stone-500 dark:text-stone-500">
          {"<repo>/.roubo/roubo.yaml"}
        </span>{" "}
        — commit alongside your other work.
      </p>
    </Tile>
  );
}
