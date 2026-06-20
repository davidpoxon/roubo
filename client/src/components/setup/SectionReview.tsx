import { useEffect, type Dispatch } from "react";
import { Button } from "react-aria-components";
import { Globe, Server, TestTube, Layers, GitFork, Settings, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RouboConfig, ComponentConfig, ToolConfig } from "@roubo/shared";
import FilePathLabel from "../FilePathLabel";
import WrapCode from "../WrapCode";
import {
  WIZARD_SECTIONS,
  REQUIRED_SECTIONS,
  SECTION_LABELS,
  type WizardSection,
  type SectionStatus,
  type WizardAction,
} from "./wizardReducer";
import { TOOL_ICON_MAP, componentTypeBadge } from "./styles";

interface Props {
  config: Partial<RouboConfig>;
  repoPath: string;
  isEditMode: boolean;
  sectionStatus: Record<WizardSection, SectionStatus>;
  dispatch: Dispatch<WizardAction>;
  onSave: () => void;
  isSaving: boolean;
  saveError?: string;
  saveSuccess: boolean;
  onRegister?: () => void;
  isRegistering?: boolean;
}

function StatusDot({ status }: { status: SectionStatus }) {
  if (status === "pristine") return null;
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        status === "valid" ? "bg-green-500" : "bg-red-400"
      }`}
    />
  );
}

function SectionHeader({
  icon: Icon,
  label,
  status,
}: {
  icon: LucideIcon;
  label: string;
  status?: SectionStatus;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={13} className="text-stone-400 dark:text-stone-600" />
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
        {label}
      </h3>
      {status && <StatusDot status={status} />}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  if (!children && (value == null || value === "")) return null;
  return (
    <div className={`flex gap-4 ${mono ? "items-start" : "items-center"}`}>
      <span
        className={`text-[11px] text-stone-500 dark:text-stone-600 shrink-0 w-28 ${mono ? "pt-1" : ""}`}
      >
        {label}
      </span>
      {children ??
        (mono ? (
          <WrapCode className="flex-1">{String(value)}</WrapCode>
        ) : (
          <span className="text-[12px] text-stone-800 dark:text-stone-200 min-w-0">{value}</span>
        ))}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400">
      {children}
    </span>
  );
}

function ItemHeader({
  icon: Icon,
  name,
  badge,
}: {
  icon?: LucideIcon;
  name: string;
  badge?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon size={14} className="text-stone-500 shrink-0" />}
      <span className="text-[12px] text-stone-800 dark:text-stone-200 font-mono font-medium">
        {name}
      </span>
      {badge && <Badge>{badge}</Badge>}
    </div>
  );
}

function ComponentMiniCard({
  name,
  component,
  port,
  maxBenches,
}: {
  name: string;
  component: ComponentConfig;
  port?: { base: number };
  maxBenches: number;
}) {
  return (
    <div className="space-y-2">
      <ItemHeader name={name} badge={componentTypeBadge(component)} />
      {component.docker && (
        <Row label="Docker">
          <span className="inline-flex items-center gap-2 min-w-0">
            <FilePathLabel path={component.docker.composeFile} />
            <span className="text-[12px] font-mono text-stone-500">
              / {component.docker.service}
            </span>
          </span>
        </Row>
      )}
      {component.command && <Row label="Command" value={component.command} mono />}
      {component.setup && <Row label="Setup" value={component.setup} mono />}
      {component.directory && (
        <Row label="Directory">
          <FilePathLabel path={component.directory} />
        </Row>
      )}
      {component.envFile && (
        <Row label="Env file">
          <FilePathLabel path={component.envFile} />
        </Row>
      )}
      {component.connection?.template && (
        <Row label="Connection" value={component.connection.template} mono />
      )}
      {component.migration && (
        <Row
          label="Migration"
          value={[component.migration.command, ...(component.migration.args ?? [])].join(" ")}
          mono
        />
      )}
      {port && (
        <Row
          label="Port"
          value={
            maxBenches > 1 ? `${port.base} \u2013 ${port.base + maxBenches - 1}` : String(port.base)
          }
          mono
        />
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolConfig }) {
  const IconComponent = TOOL_ICON_MAP[tool.icon] ?? Globe;
  return (
    <div className="space-y-2">
      <ItemHeader icon={IconComponent} name={tool.name} badge={tool.type} />
      {tool.type === "browser" ? (
        <Row label="URL" value={tool.url} mono />
      ) : (
        <Row label="Command" value={tool.command} mono />
      )}
      {tool.requires && <Row label="Requires" value={tool.requires} />}
    </div>
  );
}

export default function SectionReview({
  config,
  repoPath,
  isEditMode,
  sectionStatus,
  dispatch,
  onSave,
  isSaving,
  saveError,
  saveSuccess,
  onRegister,
  isRegistering,
}: Props) {
  const invalidSections = WIZARD_SECTIONS.filter((s) => {
    if (s === "review") return false;
    if (REQUIRED_SECTIONS.includes(s)) return sectionStatus[s] !== "valid";
    return sectionStatus[s] === "invalid";
  });
  const canSave = invalidSections.length === 0;

  useEffect(() => {
    const hasInvalid = (Object.entries(sectionStatus) as [WizardSection, SectionStatus][])
      .filter(([s]) => s !== "review")
      .some(([, status]) => status === "invalid");
    if (hasInvalid && sectionStatus.review !== "invalid") {
      dispatch({
        type: "SET_SECTION_STATUS",
        payload: { section: "review", status: "invalid" },
      });
    } else if (!hasInvalid && sectionStatus.review === "invalid") {
      dispatch({
        type: "SET_SECTION_STATUS",
        payload: { section: "review", status: "pristine" },
      });
    }
  }, [sectionStatus, dispatch]);

  const maxBenches = config.benches?.max ?? 1;

  return (
    <div className="space-y-5">
      {invalidSections.length > 0 && (
        <div className="text-[12px] text-amber-400 space-y-0.5">
          <p>Incomplete sections:</p>
          {invalidSections.map((s) => (
            <p key={s} className="pl-3">
              &bull; {SECTION_LABELS[s]}
            </p>
          ))}
        </div>
      )}

      {/* Project Info */}
      {/* FR-070 (WU-057): Repository, linked GitHub Project, and submodules
          are owned by the plugin Configure modal now, so Review omits them.
          Identity here only lists the project name. */}
      {config.project && (
        <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
          <SectionHeader icon={Globe} label="Project Info" status={sectionStatus.project} />
          <div className="space-y-2">
            <ItemHeader name={config.project.displayName || config.project.name} />
            <Row label="Name" value={config.project.name} mono />
          </div>
        </div>
      )}

      {/* Structure */}
      {config.layout && (
        <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
          <SectionHeader icon={GitFork} label="Structure" status={sectionStatus.layout} />
          <div className="space-y-2">
            {config.layout.type && <Badge>{config.layout.type}</Badge>}
          </div>
        </div>
      )}

      {/* Components */}
      {config.components && Object.keys(config.components).length > 0 && (
        <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
          <SectionHeader icon={Server} label="Components" status={sectionStatus.components} />
          <div className="divide-y divide-stone-200 dark:divide-stone-800/50">
            {Object.entries(config.components).map(([name, component]) => (
              <div key={name} className="py-4 first:pt-0 last:pb-0">
                <ComponentMiniCard
                  name={name}
                  component={component}
                  port={config.ports?.[name]}
                  maxBenches={maxBenches}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tools */}
      <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
        <SectionHeader icon={Layers} label="Tools" status={sectionStatus.tools} />
        {config.tools && config.tools.length > 0 ? (
          <div className="divide-y divide-stone-200 dark:divide-stone-800/50">
            {config.tools.map((tool, i) => (
              <div key={i} className="py-4 first:pt-0 last:pb-0">
                <ToolRow tool={tool} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-stone-400 dark:text-stone-600">None configured</p>
        )}
      </div>

      {/* Users */}
      <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
        <SectionHeader icon={Users} label="Users" status={sectionStatus.users} />
        {config.users && config.users.length > 0 ? (
          <div className="divide-y divide-stone-200 dark:divide-stone-800/50">
            {config.users.map((user, i) => (
              <div key={i} className="py-4 first:pt-0 last:pb-0 space-y-2">
                <ItemHeader name={user.name || "Untitled"} />
                {Object.entries(user.properties).map(([k, v]) => (
                  <Row key={k} label={k} value={v} mono />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-stone-400 dark:text-stone-600">None configured</p>
        )}
      </div>

      {/* Inspection */}
      <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
        <SectionHeader icon={TestTube} label="Inspection" status={sectionStatus.inspection} />
        {config.inspection &&
        (config.inspection.framework ||
          config.inspection.directory ||
          config.inspection.command) ? (
          <div className="space-y-2">
            <Row label="Framework" value={config.inspection.framework} />
            {config.inspection.directory && (
              <Row label="Directory">
                <FilePathLabel path={config.inspection.directory} />
              </Row>
            )}
            <Row label="Command" value={config.inspection.command} mono />
            {config.inspection.env && Object.keys(config.inspection.env).length > 0 && (
              <div>
                <span className="text-[11px] text-stone-500 dark:text-stone-600">Environment</span>
                <div className="mt-1 space-y-0.5 pl-2">
                  {Object.entries(config.inspection.env).map(([k, v]) => (
                    <div
                      key={k}
                      className="text-[12px] font-mono text-stone-700 dark:text-stone-300"
                    >
                      <span className="text-stone-500 dark:text-stone-400">{k}</span>
                      <span className="text-stone-400 dark:text-stone-600">=</span>
                      {v}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-stone-400 dark:text-stone-600">None configured</p>
        )}
      </div>

      {/* Benches */}
      {config.benches && (
        <div className="bg-stone-100 dark:bg-stone-900/50 rounded-lg px-5 py-4">
          <SectionHeader icon={Settings} label="Benches" status={sectionStatus.benches} />
          <div className="space-y-2">
            <Row label="Max concurrent" value={config.benches.max} />
            {config.ports && Object.keys(config.ports).length > 0 && config.benches.max && (
              <div>
                <span className="text-[11px] text-stone-500 dark:text-stone-600">Port ranges</span>
                <div className="mt-1 space-y-0.5 pl-2">
                  {Object.entries(config.ports).map(([name, port]) => (
                    <div key={name} className="flex items-center gap-3 text-[12px] font-mono">
                      <span className="text-stone-500 dark:text-stone-400 shrink-0">{name}</span>
                      <span className="text-stone-400 dark:text-stone-600 tabular-nums">
                        {port.base} &ndash; {port.base + (config.benches?.max ?? 1) - 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="opacity-60">
        <FilePathLabel path={`${repoPath}/.roubo/roubo.yaml`} />
      </div>

      <div className="flex items-center gap-3">
        <Button
          onPress={onSave}
          isDisabled={!canSave || isSaving}
          className="px-4 py-2 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 rounded-lg transition-colors outline-none"
        >
          {isSaving ? "Saving..." : "Save Config"}
        </Button>

        {saveSuccess && !isEditMode && onRegister && (
          <Button
            onPress={onRegister}
            isDisabled={isRegistering}
            className="px-4 py-2 text-sm font-medium text-stone-700 dark:text-stone-300 bg-stone-200 dark:bg-stone-800/80 hover:bg-stone-300 dark:hover:bg-stone-700 disabled:opacity-40 rounded-lg transition-colors outline-none"
          >
            {isRegistering ? "Registering..." : "Register Project"}
          </Button>
        )}
      </div>

      {saveError && <p className="text-sm text-red-400">{saveError}</p>}
      {saveSuccess && (
        <p className="text-sm text-green-500">
          {isEditMode ? "Config saved. Restart components to apply changes." : "Config saved."}
        </p>
      )}
    </div>
  );
}
