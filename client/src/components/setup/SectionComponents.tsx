import { useState, useMemo, useRef } from "react";
import { Plus, Trash2, ChevronRight } from "lucide-react";
import { Tabs, TabList, Tab, TabPanel, Button, TextField, Input } from "react-aria-components";
import type {
  ComponentConfig,
  ComponentType,
  PortConfig,
  RepoScanResult,
  ConfigValidationResult,
} from "@roubo/shared";
import { nextAvailablePort, type WizardAction } from "./wizardReducer";
import ComponentEditor from "./ComponentEditor";
import Select from "../Select";
import { filePathItems } from "../filePathItems";
import { COMPONENT_TYPE_LABELS, componentTypeBadge } from "./styles";
import { TAB_CLASS } from "../ui/Tabs";

export { COMPONENT_TYPE_LABELS };

interface Props {
  components: Record<string, ComponentConfig>;
  portNames: string[];
  ports: Record<string, PortConfig>;
  projectName: string;
  scanResult?: RepoScanResult;
  dispatch: React.Dispatch<WizardAction>;
  portConflicts: ConfigValidationResult["portConflicts"];
  onCheckConflicts: () => void;
  maxBenches: number;
  currentSubStep: string | null;
  envFileKeys?: string[];
}

const TYPE_ORDER = ["database", "process"] as const;

const TYPE_PRESET_NAMES: Record<string, string> = {
  database: "database",
  process: "server",
};

type RenderItem =
  | { kind: "standalone"; key: string; component: ComponentConfig }
  | {
      kind: "group";
      composeFile: string;
      members: { key: string; component: ComponentConfig }[];
    };

function InlineNameEditor({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onCommit(trimmed);
    } else {
      setDraft(value);
    }
  };

  return (
    <TextField
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") inputRef.current?.blur();
        if (e.key === "Escape") {
          setDraft(value);
          inputRef.current?.blur();
        }
      }}
      aria-label="Component name"
      className="flex-1 min-w-0"
    >
      <Input
        ref={inputRef}
        className="w-full bg-transparent text-13 text-text-primary font-medium border-none rounded-control px-1.5 py-0.5 -mx-1.5 hover:bg-bg-hover focus:bg-bg-field focus:outline-none focus:ring-2 focus:ring-focus-ring transition-colors font-mono"
      />
    </TextField>
  );
}

export default function SectionComponents({
  components,
  portNames,
  ports,
  projectName,
  scanResult,
  dispatch,
  portConflicts,
  onCheckConflicts,
  maxBenches,
  currentSubStep,
  envFileKeys,
}: Props) {
  const componentNames = Object.keys(components);

  const componentsByType = useMemo(() => {
    const groups: Record<string, { key: string; component: ComponentConfig }[]> = {};
    for (const t of TYPE_ORDER) groups[t] = [];

    for (const [key, component] of Object.entries(components)) {
      const type = component.type || "";
      if (groups[type]) {
        groups[type].push({ key, component });
      } else {
        if (!groups["other"]) groups["other"] = [];
        groups["other"].push({ key, component });
      }
    }
    return groups;
  }, [components]);

  const visibleTypes = useMemo(() => {
    const types: (ComponentType | "other")[] = [...TYPE_ORDER];
    if (componentsByType["other"]?.length) types.push("other");
    return types;
  }, [componentsByType]);

  const renderItemsForType = useMemo(() => {
    const result: Record<string, RenderItem[]> = {};

    for (const type of visibleTypes) {
      const entries = componentsByType[type] ?? [];

      if (type === "database") {
        const composeGroups = new Map<string, string[]>();
        for (const { key, component } of entries) {
          const cf = component.docker?.composeFile;
          if (cf) {
            composeGroups.set(cf, [...(composeGroups.get(cf) ?? []), key]);
          }
        }

        const groupedKeys = new Set<string>();
        const qualifiedGroups = new Map<string, string[]>();
        for (const [cf, keys] of composeGroups) {
          if (keys.length >= 2) {
            qualifiedGroups.set(cf, keys);
            keys.forEach((k) => groupedKeys.add(k));
          }
        }

        const items: RenderItem[] = [];
        const emittedGroups = new Set<string>();
        for (const { key } of entries) {
          if (groupedKeys.has(key)) {
            const cf = components[key].docker?.composeFile ?? "";
            if (!emittedGroups.has(cf)) {
              emittedGroups.add(cf);
              items.push({
                kind: "group",
                composeFile: cf,
                members: (qualifiedGroups.get(cf) ?? []).map((k) => ({
                  key: k,
                  component: components[k],
                })),
              });
            }
          } else {
            items.push({ kind: "standalone", key, component: components[key] });
          }
        }
        result[type] = items;
      } else {
        result[type] = entries.map((e) => ({
          kind: "standalone",
          key: e.key,
          component: e.component,
        }));
      }
    }
    return result;
  }, [componentsByType, visibleTypes, components]);

  const [activeType, setActiveType] = useState<ComponentType | "other">(() => {
    const firstPopulated = TYPE_ORDER.find((t) =>
      Object.values(components).some((s) => s.type === t),
    );
    return firstPopulated ?? TYPE_ORDER[0];
  });

  const updateGroupComposeFile = (memberKeys: string[], newComposeFile: string) => {
    for (const key of memberKeys) {
      const component = components[key];
      dispatch({
        type: "UPDATE_COMPONENT",
        payload: {
          key,
          component: {
            ...component,
            docker: {
              ...component.docker,
              composeFile: newComposeFile,
              service: component.docker?.service ?? "",
            },
          },
        },
      });
    }
  };

  const renameComponent = (oldKey: string, newKey: string) => {
    if (newKey === oldKey || !newKey) return;
    dispatch({ type: "RENAME_COMPONENT", payload: { oldKey, newKey } });
  };

  const addComponent = (type: ComponentType) => {
    const presetName = TYPE_PRESET_NAMES[type] ?? type;
    const config: ComponentConfig =
      type === "database"
        ? { type, migration: { command: "", args: [""] } }
        : { type, command: "" };
    let name = presetName;
    let n = 2;
    while (components[name]) {
      name = `${presetName}-${n}`;
      n++;
    }
    dispatch({
      type: "ADD_COMPONENT",
      payload: { key: name, component: config },
    });
    const defaultPort = 3000;
    dispatch({
      type: "ADD_PORT",
      payload: {
        key: name,
        port: { base: nextAvailablePort(defaultPort, ports, maxBenches) },
      },
    });
    setActiveType(type);
  };

  const detected = scanResult?.detected;

  // Single component editor view
  if (currentSubStep !== null && components[currentSubStep]) {
    const key = currentSubStep;
    const component = components[key];
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <InlineNameEditor value={key} onCommit={(v) => renameComponent(key, v)} />
          {scanResult?.detected.suggestedComponents?.some(
            (s) => s.key === key && s.config.type === component.type,
          ) && <span className="text-11 text-text-secondary">Auto-detected</span>}
          <Button
            onPress={() => dispatch({ type: "REMOVE_COMPONENT", payload: key })}
            className="ml-auto p-1 text-text-secondary hover:text-danger-text transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Trash2 size={14} />
          </Button>
        </div>
        <ComponentEditor
          component={component}
          portNames={portNames}
          componentNames={componentNames}
          ports={ports}
          components={components}
          projectName={projectName}
          scanResult={scanResult}
          onChange={(s) =>
            dispatch({
              type: "UPDATE_COMPONENT",
              payload: { key, component: s },
            })
          }
          portBase={ports[key]?.base ?? null}
          onPortChange={(base) => {
            if (base === null) {
              dispatch({ type: "REMOVE_PORT", payload: key });
            } else {
              dispatch({
                type: "UPDATE_PORT",
                payload: { key, port: { ...ports[key], base } },
              });
            }
            onCheckConflicts();
          }}
          portHttps={ports[key]?.https}
          onPortHttpsChange={(https) => {
            dispatch({
              type: "UPDATE_PORT",
              payload: {
                key,
                port: {
                  ...ports[key],
                  base: ports[key]?.base ?? 0,
                  https: https || undefined,
                },
              },
            });
          }}
          portConflict={portConflicts.find((c) => c.port === key)}
          maxBenches={maxBenches}
          envFileKeys={envFileKeys}
        />
      </div>
    );
  }

  // Overview: tabbed list of all components
  return (
    <div className="space-y-3">
      <Tabs
        selectedKey={activeType}
        onSelectionChange={(key) => setActiveType(key as ComponentType | "other")}
      >
        <TabList className="flex gap-1 border-b border-border mb-4">
          {visibleTypes.map((type) => {
            const count = componentsByType[type]?.length ?? 0;
            return (
              <Tab key={type} id={type} className={TAB_CLASS}>
                {COMPONENT_TYPE_LABELS[type] ?? type}
                {count > 0 && (
                  <span className="ml-1.5 text-11 bg-bg-hover text-text-secondary px-1.5 py-0.5 rounded-full tabular-nums">
                    {count}
                  </span>
                )}
              </Tab>
            );
          })}
        </TabList>

        {visibleTypes.map((type) => (
          <TabPanel key={type} id={type} className="outline-none">
            <div className="space-y-3">
              {type !== "other" && (renderItemsForType[type] ?? []).length === 0 ? (
                <Button
                  onPress={() => addComponent(type as ComponentType)}
                  className="w-full flex items-center justify-center gap-2 py-6 rounded-control border border-dashed border-border-strong hover:border-border-control hover:bg-bg-hover text-13 text-text-secondary hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <Plus size={16} />
                  Add {COMPONENT_TYPE_LABELS[type] ?? type}
                </Button>
              ) : type !== "other" ? (
                <Button
                  onPress={() => addComponent(type as ComponentType)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-12 font-medium text-text-secondary hover:text-text-primary border border-border-strong bg-bg-surface hover:bg-bg-hover rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <Plus size={14} />
                  Add {COMPONENT_TYPE_LABELS[type] ?? type}
                </Button>
              ) : null}

              {(renderItemsForType[type] ?? []).map((item) => {
                if (item.kind === "standalone") {
                  return renderOverviewCard(item.key, item.component);
                }

                const { composeFile, members } = item;
                const memberKeys = members.map((m) => m.key);
                return (
                  <div
                    key={`group:${composeFile}`}
                    className="border-l-2 border-border-strong rounded-lg bg-bg-base p-3 space-y-2"
                  >
                    <div>
                      <label className="flex items-center gap-2 text-11 font-medium uppercase tracking-label text-text-secondary mb-3">
                        <span className="size-1.5 rounded-full bg-border-strong" />
                        Docker Compose
                      </label>
                      {detected?.dockerComposeFiles.length ? (
                        <Select
                          items={filePathItems(detected.dockerComposeFiles)}
                          value={composeFile}
                          onChange={(value) => updateGroupComposeFile(memberKeys, value)}
                          placeholder="Select compose file"
                        />
                      ) : (
                        <TextField
                          value={composeFile}
                          onChange={(v) => updateGroupComposeFile(memberKeys, v)}
                          aria-label="Compose file"
                        >
                          <Input
                            placeholder="path/to/docker-compose.yml"
                            className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
                          />
                        </TextField>
                      )}
                    </div>
                    {members.map(({ key, component }) => renderOverviewCard(key, component))}
                  </div>
                );
              })}
            </div>
          </TabPanel>
        ))}
      </Tabs>
    </div>
  );

  function renderOverviewCard(key: string, component: ComponentConfig) {
    return (
      <Button
        key={key}
        onPress={() => dispatch({ type: "SET_SUB_STEP", payload: key })}
        className="group w-full flex items-center gap-2 px-3 py-2.5 rounded-control bg-bg-hover hover:bg-bg-pressed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="flex-1 text-13 font-medium text-text-body font-mono truncate">{key}</span>
        <span className="text-11 text-text-secondary group-hover:text-text-body">
          {componentTypeBadge(component)}
        </span>
        <ChevronRight
          size={14}
          className="text-text-secondary group-hover:text-text-body shrink-0"
        />
      </Button>
    );
  }
}
