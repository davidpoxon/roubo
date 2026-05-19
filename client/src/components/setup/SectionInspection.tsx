import { TextField, Label, Input, Button } from "react-aria-components";
import { Plus, X, Trash2 } from "lucide-react";
import type { InspectionConfig, PortConfig, ComponentConfig } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";
import TemplateInsert from "./TemplateInsert";
import TemplateHighlightInput, { TemplateValidationError } from "./TemplateHighlightInput";
import { validateTemplateVariables, type TemplateVariableContext } from "./templateDescriptions";
import SubdirectoryPicker from "./SubdirectoryPicker";
import { INPUT } from "./styles";

interface Props {
  inspection: InspectionConfig | undefined;
  portNames: string[];
  componentNames: string[];
  ports: Record<string, PortConfig>;
  components: Record<string, ComponentConfig>;
  projectName: string;
  repoPath: string;
  dispatch: React.Dispatch<WizardAction>;
}

const BLANK_INSPECTION: InspectionConfig = {
  framework: "",
  directory: "",
  command: "",
};

export default function SectionInspection({
  inspection,
  portNames,
  componentNames,
  ports,
  components,
  projectName,
  repoPath,
  dispatch,
}: Props) {
  const addInspection = () => {
    dispatch({ type: "UPDATE_INSPECTION", payload: BLANK_INSPECTION });
  };

  const removeInspection = () => {
    dispatch({
      type: "UPDATE_INSPECTION",
      payload: undefined,
    });
  };

  if (!inspection) {
    return (
      <div className="py-2">
        <p className="text-sm text-stone-500 dark:text-stone-600 mb-3">
          No inspection configured. This section is optional.
        </p>
        <Button
          onPress={addInspection}
          className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
        >
          <Plus size={12} /> Add inspection
        </Button>
      </div>
    );
  }

  const update = (changes: Partial<InspectionConfig>) => {
    dispatch({
      type: "UPDATE_INSPECTION",
      payload: { ...inspection, ...changes },
    });
  };
  const templateCtx: TemplateVariableContext = {
    portNames,
    componentNames,
    ports,
    components,
    projectName,
  };

  const rawEnvEntries = Object.entries(inspection.env ?? {});
  const envEntries = rawEnvEntries.length > 0 ? rawEnvEntries : [["", ""] as [string, string]];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-stone-500">Inspection settings</span>
        <Button
          onPress={removeInspection}
          aria-label="Remove inspection"
          className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-red-400 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
        >
          <Trash2 size={12} /> Remove
        </Button>
      </div>

      <TextField value={inspection.framework} onChange={(v) => update({ framework: v })}>
        <Label className="block text-xs text-stone-500 mb-1.5">Framework</Label>
        <Input placeholder="playwright" className={INPUT} />
      </TextField>

      <SubdirectoryPicker
        label="Directory"
        placeholder="tests"
        value={inspection.directory}
        onChange={(v) => update({ directory: v })}
        basePath={repoPath}
      />

      <TextField value={inspection.command} onChange={(v) => update({ command: v })}>
        <Label className="block text-xs text-stone-500 mb-1.5">Command</Label>
        <Input placeholder="npx playwright test" className={INPUT} />
      </TextField>

      <fieldset className="space-y-2">
        <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
          <span className="size-1.5 rounded-full bg-violet-400/70" />
          Environment variables
        </legend>
        {envEntries.map(([key, value], i) => {
          const invalidVars = validateTemplateVariables(value, templateCtx);
          return (
            <div key={i}>
              <div className="flex items-center gap-2">
                <TextField
                  value={key}
                  onChange={(v) => {
                    const env = { ...inspection.env };
                    Reflect.deleteProperty(env, key);
                    env[v] = value;
                    update({ env });
                  }}
                  aria-label="Environment variable name"
                  className="w-1/3"
                >
                  <Input placeholder="KEY" className={INPUT} />
                </TextField>
                <TextField
                  value={value}
                  onChange={(v) => update({ env: { ...inspection.env, [key]: v } })}
                  aria-label="Environment variable value"
                  className="flex-1"
                >
                  <div className={`${INPUT} flex items-center gap-1`}>
                    <TemplateHighlightInput
                      value={value}
                      variant="inner"
                      placeholder="value"
                      invalidVariables={invalidVars}
                    />
                    <TemplateInsert
                      ctx={templateCtx}
                      onInsert={(v) => {
                        update({
                          env: { ...inspection.env, [key]: (value ?? "") + v },
                        });
                      }}
                    />
                  </div>
                </TextField>
                <Button
                  aria-label="Remove environment variable"
                  onPress={() => {
                    const env = { ...inspection.env };
                    Reflect.deleteProperty(env, key);
                    update({
                      env: Object.keys(env).length > 0 ? env : undefined,
                    });
                  }}
                  className="p-1 text-stone-400 dark:text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
                >
                  <X size={14} />
                </Button>
              </div>
              <TemplateValidationError invalidVariables={invalidVars} />
            </div>
          );
        })}
        <Button
          onPress={() => update({ env: { ...inspection.env, "": "" } })}
          className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
        >
          <Plus size={12} /> Add variable
        </Button>
      </fieldset>
    </div>
  );
}
