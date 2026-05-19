import { TextField, Label, Input, Button } from "react-aria-components";
import { Trash2 } from "lucide-react";
import type { ToolConfig, PortConfig, ComponentConfig } from "@roubo/shared";
import Select from "../Select";
import TemplateInsert from "./TemplateInsert";
import TemplateHighlightInput, { TemplateValidationError } from "./TemplateHighlightInput";
import { validateTemplateVariables, type TemplateVariableContext } from "./templateDescriptions";
import { TOOL_ICONS, TOOL_ICON_MAP } from "./styles";

interface Props {
  tool: ToolConfig;
  index: number;
  portNames: string[];
  componentNames: string[];
  ports: Record<string, PortConfig>;
  components: Record<string, ComponentConfig>;
  projectName: string;
  onUpdate: (index: number, changes: Partial<ToolConfig>) => void;
  onRemove: (index: number) => void;
}

export default function ToolEditor({
  tool,
  index,
  portNames,
  componentNames,
  ports,
  components,
  projectName,
  onUpdate,
  onRemove,
}: Props) {
  const templateCtx: TemplateVariableContext = {
    portNames,
    componentNames,
    ports,
    components,
    projectName,
  };

  const update = (changes: Partial<ToolConfig>) => onUpdate(index, changes);

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg bg-stone-100 dark:bg-stone-900/50 px-3 py-3">
        <div className="flex items-center gap-2">
          <TextField
            value={tool.name}
            onChange={(v) => update({ name: v })}
            aria-label="Tool name"
            className="min-w-0 flex-1"
          >
            <Input
              placeholder="Tool name"
              className="bg-transparent text-sm text-stone-800 dark:text-stone-200 font-medium focus:outline-none border-none min-w-0 w-full"
            />
          </TextField>
          <Button
            aria-label="Remove tool"
            onPress={() => onRemove(index)}
            className="p-1 text-stone-400 dark:text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
          >
            <Trash2 size={13} />
          </Button>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <Label className="block text-[11px] text-stone-500 dark:text-stone-600 mb-1">
              Icon
            </Label>
            <div role="group" aria-label="Icon" className="flex gap-1">
              {TOOL_ICONS.map((iconName) => {
                const IconComponent = TOOL_ICON_MAP[iconName];
                const isSelected = tool.icon === iconName;
                return (
                  <Button
                    key={iconName}
                    aria-label={iconName}
                    onPress={() => update({ icon: iconName })}
                    className={`p-1.5 rounded-lg transition-colors duration-150 outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-500 ${
                      isSelected
                        ? "bg-stone-700 text-stone-100 ring-1 ring-stone-600"
                        : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800/60"
                    }`}
                  >
                    <IconComponent size={14} />
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="flex-1">
            <Label className="block text-[11px] text-stone-500 dark:text-stone-600 mb-1">
              Type
            </Label>
            <div role="group" aria-label="Type" className="flex gap-1">
              {(["browser", "shell"] as const).map((t) => (
                <Button
                  key={t}
                  onPress={() => update({ type: t })}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 ${
                    tool.type === t
                      ? "bg-stone-700 text-stone-100"
                      : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/50 dark:hover:bg-stone-800/60"
                  }`}
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {tool.type === "browser" ? (
          <BrowserUrlField tool={tool} templateCtx={templateCtx} update={update} />
        ) : (
          <ShellCommandField tool={tool} templateCtx={templateCtx} update={update} />
        )}

        <div>
          <Label className="block text-[11px] text-stone-500 dark:text-stone-600 mb-1">
            Requires component
          </Label>
          <Select
            items={componentNames}
            value={tool.requires ?? ""}
            allowClear
            onChange={(value) => update({ requires: value || undefined })}
            placeholder="None"
            className="w-48"
          />
        </div>
      </div>
    </div>
  );
}

const INPUT_WRAPPER =
  "w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm flex items-center gap-1";
const LABEL_CLASS = "block text-[11px] text-stone-500 dark:text-stone-600 mb-1";

function BrowserUrlField({
  tool,
  templateCtx,
  update,
}: {
  tool: ToolConfig;
  templateCtx: TemplateVariableContext;
  update: (changes: Partial<ToolConfig>) => void;
}) {
  const invalidVars = validateTemplateVariables(tool.url ?? "", templateCtx);
  return (
    <div>
      <TextField value={tool.url ?? ""} onChange={(v) => update({ url: v })}>
        <Label className={LABEL_CLASS}>URL</Label>
        <div className={INPUT_WRAPPER}>
          <TemplateHighlightInput
            value={tool.url ?? ""}
            variant="inner"
            placeholder="{{urls.frontend}}"
            invalidVariables={invalidVars}
          />
          <TemplateInsert
            ctx={templateCtx}
            onInsert={(v) => update({ url: (tool.url ?? "") + v })}
          />
        </div>
      </TextField>
      <TemplateValidationError invalidVariables={invalidVars} />
    </div>
  );
}

function ShellCommandField({
  tool,
  templateCtx,
  update,
}: {
  tool: ToolConfig;
  templateCtx: TemplateVariableContext;
  update: (changes: Partial<ToolConfig>) => void;
}) {
  const invalidVars = validateTemplateVariables(tool.command ?? "", templateCtx);
  return (
    <div>
      <TextField value={tool.command ?? ""} onChange={(v) => update({ command: v })}>
        <Label className={LABEL_CLASS}>Command</Label>
        <div className={INPUT_WRAPPER}>
          <TemplateHighlightInput
            value={tool.command ?? ""}
            variant="inner"
            placeholder='open -a "Rider" "{{workspace}}/..."'
            invalidVariables={invalidVars}
          />
          <TemplateInsert
            ctx={templateCtx}
            onInsert={(v) => update({ command: (tool.command ?? "") + v })}
          />
        </div>
      </TextField>
      <TemplateValidationError invalidVariables={invalidVars} />
    </div>
  );
}
