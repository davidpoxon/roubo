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
        <p className="text-13 text-text-secondary py-2">
          No tools configured. This section is optional.
        </p>
      )}

      {tools.map((tool, i) => {
        const IconComponent = TOOL_ICON_MAP[tool.icon ?? ""] ?? TOOL_ICON_MAP["globe"];
        const isExpanded = expandedIndex === i;

        return (
          <div key={i}>
            <Button
              onPress={() => toggleExpand(i)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-control transition-colors text-left outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring ${
                isExpanded
                  ? "bg-bg-pressed ring-1 ring-border-strong"
                  : "bg-bg-hover hover:bg-bg-pressed"
              }`}
            >
              <IconComponent size={12} className="text-text-secondary shrink-0" />
              <span className="flex-1 text-13 font-medium text-text-body truncate">
                {tool.name || "Untitled"}
              </span>
              <span className="text-11 text-text-secondary shrink-0">{tool.type}</span>
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
        className="flex items-center gap-1 text-11 text-text-secondary hover:text-text-primary transition-colors outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring rounded-control mt-1"
      >
        <Plus size={12} /> Add tool
      </Button>
    </div>
  );
}
