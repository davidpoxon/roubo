import { useCallback } from "react";
import { Button, TooltipTrigger, Tooltip, TextField, Input } from "react-aria-components";
import { Plus, X, Info } from "lucide-react";
import type { LayoutConfig, RepoScanResult } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";
import { INPUT } from "./styles";

interface Props {
  structure: Partial<LayoutConfig>;
  scanResult?: RepoScanResult;
  dispatch: React.Dispatch<WizardAction>;
}

const STRUCTURE_TYPES = ["meta-repo", "monorepo", "single-repo"] as const;

export default function SectionLayout({ structure, scanResult, dispatch }: Props) {
  const update = useCallback(
    (changes: Partial<LayoutConfig>) => {
      dispatch({ type: "UPDATE_STRUCTURE", payload: changes });
    },
    [dispatch],
  );

  const submodules = structure.submodules ?? {};
  const subEntries = Object.entries(submodules);

  const addSubmodule = () => {
    update({ submodules: { ...submodules, "": "" } });
  };

  const updateSubmodule = (oldKey: string, newKey: string, value: string) => {
    const updated = { ...submodules };
    if (oldKey !== newKey) Reflect.deleteProperty(updated, oldKey);
    updated[newKey] = value;
    update({ submodules: updated });
  };

  const removeSubmodule = (key: string) => {
    const updated = { ...submodules };
    Reflect.deleteProperty(updated, key);
    update({ submodules: updated });
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-xs text-stone-500 mb-1.5">Repository structure</label>
        <div className="flex gap-1">
          {STRUCTURE_TYPES.map((t) => (
            <Button
              key={t}
              onPress={() => update({ type: t })}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors outline-none ${
                structure.type === t
                  ? "bg-stone-700 text-stone-100"
                  : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/50 dark:hover:bg-stone-800/60"
              }`}
            >
              {t}
            </Button>
          ))}
        </div>
        {scanResult && structure.type === scanResult.detected.structureType && (
          <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">Auto-detected</p>
        )}
      </div>

      {structure.type === "meta-repo" && (
        <div>
          <label className="block text-xs text-stone-500 mb-1.5">Submodules</label>
          {subEntries.length > 0 && (
            <div className="flex items-center gap-2 mb-1">
              <span className="flex-1 flex items-center gap-1 text-[11px] text-stone-500 dark:text-stone-600">
                Alias
                <TooltipTrigger delay={500}>
                  <Button className="text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors outline-none">
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
            {subEntries.map(([key, value], i) => (
              <div key={i} className="flex items-center gap-2">
                <TextField
                  value={key}
                  onChange={(v) => updateSubmodule(key, v, value)}
                  aria-label="Submodule alias"
                  className="flex-1"
                >
                  <Input placeholder="alias (e.g. backend)" className={INPUT} />
                </TextField>
                <TextField
                  value={value}
                  onChange={(v) => updateSubmodule(key, key, v)}
                  aria-label="Submodule directory"
                  className="flex-1"
                >
                  <Input placeholder="directory name" className={INPUT} />
                </TextField>
                <Button
                  onPress={() => removeSubmodule(key)}
                  className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none"
                >
                  <X size={14} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            onPress={addSubmodule}
            className="flex items-center gap-1 mt-2 text-[11px] text-stone-500 hover:text-stone-300 transition-colors outline-none"
          >
            <Plus size={12} />
            Add submodule
          </Button>
        </div>
      )}
    </div>
  );
}
