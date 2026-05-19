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
      className="inline-flex rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 p-1"
    >
      <Radio
        value="guided"
        className={({ isSelected }) =>
          `px-3 py-1.5 rounded-md text-[12px] font-medium inline-flex items-center gap-1.5 cursor-pointer select-none transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-amber-400 ${
            isSelected
              ? "bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-stone-100"
              : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          }`
        }
      >
        <LayoutGrid size={12} />
        Guided
      </Radio>

      <Radio
        value="yaml"
        className={({ isSelected }) =>
          `px-3 py-1.5 rounded-md text-[12px] font-medium inline-flex items-center gap-1.5 cursor-pointer select-none transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-amber-400 ${
            isSelected
              ? "bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-stone-100"
              : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          }`
        }
      >
        <Code size={12} />
        YAML
        <span className="text-[9px] text-stone-400 dark:text-stone-500 font-mono px-1 py-px rounded bg-stone-100 dark:bg-stone-950/50 border border-stone-200 dark:border-stone-800">
          advanced
        </span>
      </Radio>
    </RadioGroup>
  );
}
