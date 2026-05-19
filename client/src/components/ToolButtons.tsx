import { useState } from "react";
import { Button, MenuTrigger, Menu, MenuItem, Popover } from "react-aria-components";
import { ChevronDown, ExternalLink } from "lucide-react";
import { TOOL_ICON_MAP } from "./setup/styles";
import { useTools, useExecuteTool } from "../hooks/useTools";
import { useProjects } from "../hooks/useProjects";
import { useToast } from "../hooks/useToast";
import UserPickerModal from "./UserPickerModal";
import { getToolErrorMessage } from "../lib/tool-error-message";
import type { ResolvedTool } from "@roubo/shared";

interface Props {
  projectId: string;
  benchId: number;
  compact?: boolean;
}

function ToolMenu({
  tools,
  onAction,
}: {
  tools: Pick<ResolvedTool, "icon" | "name" | "enabled">[];
  onAction: (index: number) => void;
}) {
  return (
    <Popover
      placement="bottom end"
      offset={6}
      className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl p-1 min-w-[12rem]"
    >
      <Menu onAction={(key) => onAction(Number(key))} className="outline-none">
        {tools.map((tool, index) => {
          const Icon = TOOL_ICON_MAP[tool.icon];
          return (
            <MenuItem
              key={index}
              id={String(index)}
              isDisabled={!tool.enabled}
              className={({ isFocused, isDisabled }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs cursor-default outline-none transition-colors ${
                  isDisabled ? "opacity-30" : ""
                } ${isFocused && !isDisabled ? "bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100" : "text-stone-500 dark:text-stone-400"}`
              }
            >
              {Icon && <Icon size={14} className="shrink-0" />}
              {tool.name}
            </MenuItem>
          );
        })}
      </Menu>
    </Popover>
  );
}

export default function ToolButtons({ projectId, benchId, compact }: Props) {
  const { data: tools } = useTools(projectId, benchId);
  const executeTool = useExecuteTool();
  const { data: projects } = useProjects();
  const { addToast } = useToast();
  const [pickerToolIndex, setPickerToolIndex] = useState<number | null>(null);

  if (!tools || tools.length === 0) return null;

  const users = projects?.find((p) => p.id === projectId)?.config?.users;

  const execute = (index: number) => {
    const tool = tools[index];
    if (tool?.requiresUserPicker && users && users.length > 0) {
      setPickerToolIndex(index);
    } else {
      executeTool.mutate(
        { projectId, benchId, index },
        {
          onError: (err) => addToast(getToolErrorMessage(err), { duration: 8000 }),
        },
      );
    }
  };

  const handleUserSelect = (userName: string) => {
    if (pickerToolIndex !== null) {
      executeTool.mutate(
        { projectId, benchId, index: pickerToolIndex, userName },
        {
          onError: (err) => addToast(getToolErrorMessage(err), { duration: 8000 }),
        },
      );
    }
    setPickerToolIndex(null);
  };

  const primary = tools[0];
  const PrimaryIcon = TOOL_ICON_MAP[primary.icon];
  const hasMore = tools.length > 1;

  let toolsContent: React.ReactNode;

  // Compact: single icon trigger → full menu
  if (compact) {
    toolsContent = (
      <MenuTrigger>
        <Button className="p-1.5 rounded-md text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none">
          <ExternalLink size={13} />
        </Button>
        <ToolMenu tools={tools} onAction={execute} />
      </MenuTrigger>
    );
  } else if (!hasMore) {
    // Single tool — simple button
    toolsContent = (
      <Button
        isDisabled={!primary.enabled}
        onPress={() => execute(0)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-500 rounded-lg not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 not-disabled:hover:bg-stone-100 dark:not-disabled:hover:bg-stone-800 disabled:opacity-40 transition-colors outline-none"
      >
        {PrimaryIcon && <PrimaryIcon size={12} />}
        {primary.name}
      </Button>
    );
  } else {
    // Multiple tools — split button
    toolsContent = (
      <div className="flex items-center">
        <Button
          isDisabled={!primary.enabled}
          onPress={() => execute(0)}
          className="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 text-xs font-medium text-stone-500 rounded-l-lg not-disabled:hover:text-stone-700 dark:not-disabled:hover:text-stone-200 not-disabled:hover:bg-stone-100 dark:not-disabled:hover:bg-stone-800 disabled:opacity-40 transition-colors outline-none"
        >
          {PrimaryIcon && <PrimaryIcon size={12} />}
          {primary.name}
        </Button>
        <MenuTrigger>
          <Button className="flex items-center px-1.5 py-1.5 text-stone-400 dark:text-stone-600 rounded-r-lg border-l border-stone-200 dark:border-stone-700/30 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none">
            <ChevronDown size={11} />
          </Button>
          <ToolMenu tools={tools} onAction={execute} />
        </MenuTrigger>
      </div>
    );
  }

  return (
    <>
      {toolsContent}
      {users && users.length > 0 && (
        <UserPickerModal
          isOpen={pickerToolIndex !== null}
          onClose={() => setPickerToolIndex(null)}
          onSelect={handleUserSelect}
          users={users}
        />
      )}
    </>
  );
}
