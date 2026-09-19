import { RadioGroup, Radio } from "react-aria-components";
import { LayoutGrid, Code } from "lucide-react";

export type SetupMode = "guided" | "yaml";

interface Props {
  mode: SetupMode;
  onChange: (mode: SetupMode) => void;
}

export default function GuidedYamlToggle({ mode, onChange }: Props) {
  return (
    <RadioGroup
      value={mode}
      onChange={(v) => onChange(v as SetupMode)}
      aria-label="Setup mode"
      orientation="horizontal"
      className="inline-flex rounded-lg border border-border bg-bg-base p-1"
    >
      <Radio
        value="guided"
        className={({ isSelected }) =>
          `px-3 py-1.5 rounded-control text-12 font-medium inline-flex items-center gap-1.5 cursor-pointer select-none transition-colors outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring ${
            isSelected
              ? "bg-bg-pressed text-text-primary"
              : "text-text-secondary hover:text-text-primary"
          }`
        }
      >
        <LayoutGrid size={12} />
        Guided
      </Radio>

      <Radio
        value="yaml"
        className={({ isSelected }) =>
          `px-3 py-1.5 rounded-control text-12 font-medium inline-flex items-center gap-1.5 cursor-pointer select-none transition-colors outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring ${
            isSelected
              ? "bg-bg-pressed text-text-primary"
              : "text-text-secondary hover:text-text-primary"
          }`
        }
      >
        <Code size={12} />
        YAML
        <span className="text-11 text-text-secondary font-mono px-1 py-px rounded bg-bg-base border border-border">
          advanced
        </span>
      </Radio>
    </RadioGroup>
  );
}
