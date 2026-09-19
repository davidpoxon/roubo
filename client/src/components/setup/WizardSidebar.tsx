import { useState } from "react";
import { useNavigate } from "react-router";
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
        className="flex items-center gap-1.5 text-11 text-text-secondary hover:text-text-primary transition-colors mb-8 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                className={`outline-none focus-visible:ring-2 focus-visible:ring-focus-ring w-full text-left px-2 py-1.5 rounded-control text-13 transition-colors flex items-center gap-2 ${
                  active && !currentSubStep
                    ? "text-accent-text bg-accent-muted"
                    : active && currentSubStep
                      ? "text-accent-text"
                      : "text-text-secondary hover:text-text-primary"
                }`}
              >
                <Icon
                  size={14}
                  className={`shrink-0 transition-colors ${
                    status === "valid"
                      ? "text-success-text"
                      : status === "invalid"
                        ? "text-danger-text"
                        : "text-text-secondary"
                  }`}
                />
                {SECTION_LABELS[section]}
                {optional && <span className="text-11 text-text-secondary">opt</span>}
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
                        className={`outline-none focus-visible:ring-2 focus-visible:ring-focus-ring w-full text-left px-2 py-1 rounded-control text-12 transition-colors flex items-center gap-1.5 ${
                          subActive
                            ? "text-accent-text bg-accent-muted"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        <ComponentIcon size={12} className="shrink-0 text-text-secondary" />
                        <span className="truncate">{key}</span>
                      </Button>
                    );
                  })}
                  <DialogTrigger isOpen={addComponentOpen} onOpenChange={setAddComponentOpen}>
                    <Button className="w-full text-left px-2 py-1 rounded-control text-11 text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
                      <Plus size={12} />
                      Add
                    </Button>
                    <Popover
                      placement="bottom start"
                      className="animate-rise-in rounded-control bg-bg-surface border border-border shadow-elevation-0 py-1 z-50 w-36 outline-none"
                    >
                      <Button
                        onPress={() => {
                          setAddComponentOpen(false);
                          onAddComponent("database");
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-12 text-text-body hover:bg-bg-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-control"
                      >
                        <Database size={12} className="text-text-secondary shrink-0" />
                        Database
                      </Button>
                      <Button
                        onPress={() => {
                          setAddComponentOpen(false);
                          onAddComponent("process");
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-12 text-text-body hover:bg-bg-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-control"
                      >
                        <Server size={12} className="text-text-secondary shrink-0" />
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
                    const ToolIcon = TOOL_ICON_MAP[tool.icon ?? ""] ?? Globe;
                    return (
                      <Button
                        key={tool.name || String(i)}
                        onPress={() => onNavigateSubStep("tools", subKey)}
                        className={`outline-none focus-visible:ring-2 focus-visible:ring-focus-ring w-full text-left px-2 py-1 rounded-control text-12 transition-colors flex items-center gap-1.5 ${
                          subActive
                            ? "text-accent-text bg-accent-muted"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        <ToolIcon size={12} className="shrink-0 text-text-secondary" />
                        <span className="truncate">{tool.name || "Untitled"}</span>
                      </Button>
                    );
                  })}
                  <Button
                    onPress={onAddTool}
                    className="w-full text-left px-2 py-1 rounded-control text-11 text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Plus size={12} />
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
                        className={`outline-none focus-visible:ring-2 focus-visible:ring-focus-ring w-full text-left px-2 py-1 rounded-control text-12 transition-colors flex items-center gap-1.5 ${
                          subActive
                            ? "text-accent-text bg-accent-muted"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        <Users size={12} className="shrink-0 text-text-secondary" />
                        <span className="truncate">{user.name || "Untitled"}</span>
                      </Button>
                    );
                  })}
                  <Button
                    onPress={onAddUser}
                    className="w-full text-left px-2 py-1 rounded-control text-11 text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <Plus size={12} />
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
