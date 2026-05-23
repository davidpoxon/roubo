import { RadioGroup } from "react-aria-components";
import { ListChecks } from "lucide-react";
import { DEFAULT_BENCH_SETTINGS } from "@roubo/shared";
import { useSettings } from "../../hooks/useSettings";
import Tile from "../settings/Tile";
import { JigPickerOption } from "../ProjectDefaultJigTile";
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

export function EnforceIssueDependenciesOverrideTile({
  draft,
  onChange,
}: {
  draft: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const { settings } = useSettings();
  const appDefault =
    settings?.benches?.enforceIssueDependencies ?? DEFAULT_BENCH_SETTINGS.enforceIssueDependencies;

  const isOverridden = draft !== null;
  const selectedValue = toRadioValue(draft);
  const effectiveValue = draft ?? appDefault;

  return (
    <Tile
      icon={<ListChecks aria-hidden="true" size={14} />}
      title="Enforce issue dependencies"
      ariaLabel="Enforce issue dependencies override"
      data-testid="enforce-issue-dependencies-tile"
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
        aria-label="Enforce issue dependencies override"
        className="flex flex-col gap-2"
      >
        <JigPickerOption
          value="inherit"
          label="Use app default"
          sublabel={`App default: ${appDefault ? "on" : "off"}`}
        />
        <JigPickerOption value="on" label="Force on" />
        <JigPickerOption value="off" label="Force off" />
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
