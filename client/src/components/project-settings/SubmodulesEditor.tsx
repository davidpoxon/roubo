import { TextField, Label, Input, Button, TooltipTrigger, Tooltip } from "react-aria-components";
import { Info, Plus, X } from "lucide-react";
import { INPUT } from "../setup/styles";

interface Props {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  errorText?: string;
}

export default function SubmodulesEditor({ value, onChange, errorText }: Props) {
  const entries = Object.entries(value);

  const add = () => onChange({ ...value, "": "" });
  const update = (oldKey: string, newKey: string, val: string) => {
    const next = { ...value };
    if (oldKey !== newKey) Reflect.deleteProperty(next, oldKey);
    next[newKey] = val;
    onChange(next);
  };
  const remove = (key: string) => {
    const next = { ...value };
    Reflect.deleteProperty(next, key);
    onChange(next);
  };

  return (
    <div>
      <Label className="block text-xs text-stone-500 mb-1.5">Submodules</Label>
      {entries.length > 0 && (
        <div className="flex items-center gap-2 mb-1">
          <span className="flex-1 flex items-center gap-1 text-[11px] text-stone-500 dark:text-stone-600">
            Alias
            <TooltipTrigger delay={500}>
              <Button className="text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded">
                <Info size={11} />
              </Button>
              <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg max-w-56">
                A short name used to reference this submodule in components and tools
              </Tooltip>
            </TooltipTrigger>
          </span>
          <span className="flex-1 text-[11px] text-stone-600">Directory</span>
          <span className="w-[22px] shrink-0" />
        </div>
      )}
      <div className="space-y-2">
        {entries.map(([key, val], i) => (
          <div key={i} className="flex items-center gap-2">
            <TextField
              value={key}
              onChange={(v) => update(key, v, val)}
              aria-label="Submodule alias"
              className="flex-1"
            >
              <Input placeholder="alias (e.g. backend)" className={INPUT} />
            </TextField>
            <TextField
              value={val}
              onChange={(v) => update(key, key, v)}
              aria-label="Submodule directory"
              className="flex-1"
            >
              <Input placeholder="directory name" className={INPUT} />
            </TextField>
            <Button
              aria-label="Remove submodule"
              onPress={() => remove(key)}
              className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
            >
              <X size={14} />
            </Button>
          </div>
        ))}
      </div>
      <Button
        onPress={add}
        className="flex items-center gap-1 mt-2 text-[11px] text-stone-500 hover:text-stone-300 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
      >
        <Plus size={12} />
        Add submodule
      </Button>
      {errorText && <p className="mt-1.5 text-[11px] text-red-400">{errorText}</p>}
    </div>
  );
}
