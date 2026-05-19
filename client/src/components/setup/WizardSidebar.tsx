import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, DialogTrigger, Popover } from "react-aria-components";
import { ArrowLeft, Plus, Database, Server, Globe, Users } from "lucide-react";
import type { ComponentConfig, ComponentType, ToolConfig, UserConfig } from "@roubo/shared";
import {
  WIZARD_SECTIONS,
  SECTION_LABELS,
  SECTION_ICONS,
  REQUIRED_SECTIONS,
  type WizardSection,
  type SectionStatus,
} from "./wizardReducer";
import { TOOL_ICON_MAP } from "./styles";

interface WizardSidebarProps {
  projectId?: string;
  currentSection: WizardSection;
  currentSubStep: string | null;
  sectionStatus: Record<WizardSection, SectionStatus>;
  components: Record<string, ComponentConfig>;
  tools: ToolConfig[];
  users: UserConfig[];
  onNavigate: (section: WizardSection) => void;
  onNavigateSubStep: (section: WizardSection, subStep: string) => void;
  onAddComponent: (type: ComponentType) => void;
  onAddTool: () => void;
  onAddUser: () => void;
}

function componentIcon(component: ComponentConfig) {
  return component.type === "database" ? Database : Server;
}

export default function WizardSidebar({
  projectId,
  currentSection,
  currentSubStep,
  sectionStatus,
  components,
  tools,
  users,
  onNavigate,
  onNavigateSubStep,
  onAddComponent,
  onAddTool,
  onAddUser,
}: WizardSidebarProps) {
  const navigate = useNavigate();
  const [addComponentOpen, setAddComponentOpen] = useState(false);

  const componentKeys = Object.keys(components);

  return (
    <nav className="w-44 shrink-0 pt-8 pl-8">
      <Button
        onPress={() => navigate(projectId ? `/projects/${projectId}/settings` : "/settings")}
        className="flex items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-400 transition-colors mb-8"
      >
        <ArrowLeft size={12} />
        Settings
      </Button>

      <div className="space-y-0.5">
        {WIZARD_SECTIONS.map((section) => {
          const active = section === currentSection;
          const status = sectionStatus[section];
          const optional = !REQUIRED_SECTIONS.includes(section) && section !== "review";
          const Icon = SECTION_ICONS[section];

          return (
            <div key={section}>
              <Button
                onPress={() => onNavigate(section)}
                className={`w-full text-left px-2 py-1.5 rounded text-[13px] transition-colors flex items-center gap-2 ${
                  active && !currentSubStep
                    ? "text-amber-600 dark:text-amber-400 bg-amber-500/8"
                    : active && currentSubStep
                      ? "text-amber-600/70 dark:text-amber-400/70"
                      : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
                }`}
              >
                <Icon
                  size={13}
                  className={`shrink-0 transition-colors ${
                    status === "valid"
                      ? "text-green-500"
                      : status === "invalid"
                        ? "text-red-400"
                        : "text-stone-400 dark:text-stone-700"
                  }`}
                />
                {SECTION_LABELS[section]}
                {optional && (
                  <span className="text-[10px] text-stone-400 dark:text-stone-700">opt</span>
                )}
              </Button>

              {section === "components" && (
                <div className="ml-5 mt-0.5 space-y-0.5">
                  {componentKeys.map((key) => {
                    const subActive = currentSection === "components" && currentSubStep === key;
                    const ComponentIcon = componentIcon(components[key]);
                    return (
                      <Button
                        key={key}
                        onPress={() => onNavigateSubStep("components", key)}
                        className={`w-full text-left px-2 py-1 rounded text-[12px] transition-colors flex items-center gap-1.5 ${
                          subActive
                            ? "text-amber-600 dark:text-amber-400 bg-amber-500/8"
                            : "text-stone-400 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-300"
                        }`}
                      >
                        <ComponentIcon
                          size={11}
                          className="shrink-0 text-stone-400 dark:text-stone-600"
                        />
                        <span className="truncate">{key}</span>
                      </Button>
                    );
                  })}
                  <DialogTrigger isOpen={addComponentOpen} onOpenChange={setAddComponentOpen}>
                    <Button className="w-full text-left px-2 py-1 rounded text-[11px] text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors flex items-center gap-1">
                      <Plus size={10} />
                      Add
                    </Button>
                    <Popover
                      placement="bottom start"
                      className="rounded-lg bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 shadow-xl py-1 z-50 w-36 outline-none"
                    >
                      <Button
                        onPress={() => {
                          setAddComponentOpen(false);
                          onAddComponent("database");
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded"
                      >
                        <Database
                          size={12}
                          className="text-stone-400 dark:text-stone-500 shrink-0"
                        />
                        Database
                      </Button>
                      <Button
                        onPress={() => {
                          setAddComponentOpen(false);
                          onAddComponent("process");
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded"
                      >
                        <Server size={12} className="text-stone-400 dark:text-stone-500 shrink-0" />
                        Process
                      </Button>
                    </Popover>
                  </DialogTrigger>
                </div>
              )}

              {section === "tools" && (
                <div className="ml-5 mt-0.5 space-y-0.5">
                  {tools.map((tool, i) => {
                    const subKey = `tool-${i}`;
                    const subActive = currentSection === "tools" && currentSubStep === subKey;
                    const ToolIcon = TOOL_ICON_MAP[tool.icon] ?? Globe;
                    return (
                      <Button
                        key={tool.name || String(i)}
                        onPress={() => onNavigateSubStep("tools", subKey)}
                        className={`w-full text-left px-2 py-1 rounded text-[12px] transition-colors flex items-center gap-1.5 ${
                          subActive
                            ? "text-amber-600 dark:text-amber-400 bg-amber-500/8"
                            : "text-stone-400 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-300"
                        }`}
                      >
                        <ToolIcon
                          size={11}
                          className="shrink-0 text-stone-400 dark:text-stone-600"
                        />
                        <span className="truncate">{tool.name || "Untitled"}</span>
                      </Button>
                    );
                  })}
                  <Button
                    onPress={onAddTool}
                    className="w-full text-left px-2 py-1 rounded text-[11px] text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors flex items-center gap-1"
                  >
                    <Plus size={10} />
                    Add
                  </Button>
                </div>
              )}

              {section === "users" && (
                <div className="ml-5 mt-0.5 space-y-0.5">
                  {users.map((user, i) => {
                    const subKey = `user-${i}`;
                    const subActive = currentSection === "users" && currentSubStep === subKey;
                    return (
                      <Button
                        key={i}
                        onPress={() => onNavigateSubStep("users", subKey)}
                        className={`w-full text-left px-2 py-1 rounded text-[12px] transition-colors flex items-center gap-1.5 ${
                          subActive
                            ? "text-amber-600 dark:text-amber-400 bg-amber-500/8"
                            : "text-stone-400 dark:text-stone-600 hover:text-stone-700 dark:hover:text-stone-300"
                        }`}
                      >
                        <Users size={11} className="shrink-0 text-stone-400 dark:text-stone-600" />
                        <span className="truncate">{user.name || "Untitled"}</span>
                      </Button>
                    );
                  })}
                  <Button
                    onPress={onAddUser}
                    className="w-full text-left px-2 py-1 rounded text-[11px] text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors flex items-center gap-1"
                  >
                    <Plus size={10} />
                    Add
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
