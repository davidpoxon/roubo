import { useState } from "react";
import { Button } from "react-aria-components";
import { Plus } from "lucide-react";
import type { ToolConfig, PortConfig, ComponentConfig } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";
import ToolEditor from "./ToolEditor";
import { TOOL_ICON_MAP } from "./styles";

interface Props {
  tools: ToolConfig[];
  portNames: string[];
  componentNames: string[];
  ports: Record<string, PortConfig>;
  components: Record<string, ComponentConfig>;
  projectName: string;
  dispatch: React.Dispatch<WizardAction>;
}

export default function ToolChipList({
  tools,
  portNames,
  componentNames,
  ports,
  components,
  projectName,
  dispatch,
}: Props) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const updateTool = (index: number, changes: Partial<ToolConfig>) => {
    dispatch({
      type: "SET_TOOLS",
      payload: tools.map((t, i) => (i === index ? { ...t, ...changes } : t)),
    });
  };

  const removeTool = (index: number) => {
    dispatch({
      type: "SET_TOOLS",
      payload: tools.filter((_, i) => i !== index),
    });
    setExpandedIndex((prev) => {
      if (prev === null) return null;
      if (prev === index) return null;
      if (prev > index) return prev - 1;
      return prev;
    });
  };

  const addTool = () => {
    const newIndex = tools.length;
    dispatch({
      type: "SET_TOOLS",
      payload: [...tools, { name: "", icon: "globe", type: "browser" }],
    });
    setExpandedIndex(newIndex);
  };

  const toggleExpand = (index: number) => {
    setExpandedIndex((prev) => (prev === index ? null : index));
  };

  return (
    <div className="space-y-2">
      {tools.length === 0 && (
        <p className="text-sm text-stone-500 dark:text-stone-600 py-2">
          No tools configured. This section is optional.
        </p>
      )}

      {tools.map((tool, i) => {
        const IconComponent = TOOL_ICON_MAP[tool.icon] ?? TOOL_ICON_MAP["globe"];
        const isExpanded = expandedIndex === i;

        return (
          <div key={i}>
            <Button
              onPress={() => toggleExpand(i)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 ${
                isExpanded
                  ? "bg-stone-200/70 dark:bg-stone-800/70 ring-1 ring-stone-300 dark:ring-stone-700"
                  : "bg-stone-100 dark:bg-stone-900/50 hover:bg-stone-200/60 dark:hover:bg-stone-800/60"
              }`}
            >
              <IconComponent size={13} className="text-stone-500 dark:text-stone-400 shrink-0" />
              <span className="flex-1 text-sm font-medium text-stone-700 dark:text-stone-300 truncate">
                {tool.name || "Untitled"}
              </span>
              <span className="text-[11px] text-stone-400 dark:text-stone-600 shrink-0">
                {tool.type}
              </span>
            </Button>

            {isExpanded && (
              <div className="mt-1 ml-2">
                <ToolEditor
                  tool={tool}
                  index={i}
                  portNames={portNames}
                  componentNames={componentNames}
                  ports={ports}
                  components={components}
                  projectName={projectName}
                  onUpdate={updateTool}
                  onRemove={removeTool}
                />
              </div>
            )}
          </div>
        );
      })}

      <Button
        onPress={addTool}
        className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded mt-1"
      >
        <Plus size={12} /> Add tool
      </Button>
    </div>
  );
}
