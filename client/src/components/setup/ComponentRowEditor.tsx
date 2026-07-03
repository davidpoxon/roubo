import { useEffect, useMemo, useRef, useState } from "react";
import { Button, TextField, Input, Label } from "react-aria-components";
import { ChevronRight, Plus, Trash2, X } from "lucide-react";
import type { ComponentConfig, ComponentType } from "@roubo/shared";
import { usePlugins } from "../../hooks/usePlugins";
import Select from "../Select";
import ConfigSchemaForm from "../ConfigSchemaForm";

interface Props {
  componentKey: string;
  component: ComponentConfig;
  portBase: number | undefined;
  maxBenches: number;
  otherComponentNames: string[];
  isExpanded: boolean;
  renameError?: string;
  portConflictLabel?: string;
  onToggleExpand: () => void;
  onRename: (newName: string) => void;
  onResetRename?: () => void;
  onUpdate: (changes: Partial<ComponentConfig>) => void;
  onUpdatePort: (base: number) => void;
  onRequestRemove: () => void;
}

type DraftEnv = { k: string; v: string };

function draftsToRecord(drafts: DraftEnv[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { k, v } of drafts) {
    const key = k.trim();
    if (key) out[key] = v;
  }
  return out;
}

// Seed a fresh `config` object for a newly selected component plugin's schema,
// mirroring PluginConfigureDialog.seedInitialValues: skip array/object
// properties the inline ConfigSchemaForm cannot edit, so a stale key from a
// previously selected plugin never rides into the persisted config. Scalars
// default to their schema `default`, `false` for booleans, or "" otherwise.
function seedConfigForSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [key, raw] of Object.entries(props)) {
    const def = (raw ?? {}) as { default?: unknown; type?: string };
    if (def.type === "array" || def.type === "object") continue;
    if (def.default !== undefined) out[key] = def.default;
    else if (def.type === "boolean") out[key] = false;
    else out[key] = "";
  }
  return out;
}

function RoleBadge({ role }: { role: ComponentType | undefined }) {
  // A plugin-bound component (issue #608) carries no legacy `type`; render a
  // neutral "Plugin" badge for it. Existing database/process components are
  // unchanged.
  const isDb = role === "database";
  const isPlugin = role === undefined;
  return (
    <span
      className={
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide border " +
        (isDb
          ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/25"
          : "bg-stone-500/10 text-stone-400 border-stone-500/25")
      }
    >
      {isPlugin ? "Plugin" : isDb ? "Database" : "Process"}
    </span>
  );
}

function InlineNameInput({
  value,
  onCommit,
  onReset,
  hasError,
}: {
  value: string;
  onCommit: (v: string) => void;
  onReset?: () => void;
  hasError: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value);
  }

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(value);
      onReset?.();
      return;
    }
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onCommit(trimmed);
    } else {
      setDraft(value);
      onReset?.();
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
          cancelRef.current = true;
          inputRef.current?.blur();
        }
      }}
      aria-label="Component name"
      className="flex-1 min-w-0"
    >
      <Input
        ref={inputRef}
        placeholder="component-name"
        className={
          "w-full bg-transparent font-mono text-sm text-stone-800 dark:text-stone-200 font-medium border rounded px-1.5 py-0.5 outline-none transition-colors " +
          (hasError
            ? "border-red-400/60 focus:border-red-400"
            : "border-transparent hover:border-stone-300 dark:hover:border-stone-700 focus:border-stone-400 dark:focus:border-stone-600 focus:bg-stone-50 dark:focus:bg-stone-950/60")
        }
      />
    </TextField>
  );
}

const FIELD_LABEL =
  "block text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-600 mb-1.5";

const FIELD_INPUT =
  "w-full rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 px-3 py-1.5 text-[13px] text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-700 outline-none transition-colors hover:border-stone-300 dark:hover:border-stone-700 focus:border-stone-400 dark:focus:border-stone-600 focus:bg-white dark:focus:bg-stone-900";

const HERO_INPUT =
  "w-full rounded-md bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 px-3.5 py-2.5 text-sm font-mono text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-700 outline-none transition-colors hover:border-stone-300 dark:hover:border-stone-700 focus:border-amber-500/60 focus:bg-white dark:focus:bg-stone-900";

export default function ComponentRowEditor({
  componentKey,
  component,
  portBase,
  maxBenches,
  otherComponentNames,
  isExpanded,
  renameError,
  portConflictLabel,
  onToggleExpand,
  onRename,
  onResetRename,
  onUpdate,
  onUpdatePort,
  onRequestRemove,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [envDraft, setEnvDraft] = useState<DraftEnv[]>(() =>
    Object.entries(component.env ?? {}).map(([k, v]) => ({ k, v })),
  );
  const lastEmittedEnvJson = useRef<string>(JSON.stringify(component.env ?? {}));

  useEffect(() => {
    const currentJson = JSON.stringify(component.env ?? {});
    if (currentJson !== lastEmittedEnvJson.current) {
      lastEmittedEnvJson.current = currentJson;
      setEnvDraft(Object.entries(component.env ?? {}).map(([k, v]) => ({ k, v })));
    }
  }, [component.env]);

  const stride = maxBenches > 1 ? maxBenches - 1 : 0;

  // Component-plugin binding (issue #390, CPHM-FR-010). Only `component`-kind
  // plugins are bindable here; integration plugins are filtered out. Selecting
  // a plugin sets `plugin: { id }` and re-seeds `config` for that plugin's
  // schema. The deprecated `component.type` is never written.
  const { data: pluginsData } = usePlugins();
  const componentPlugins = useMemo(
    () =>
      (pluginsData?.plugins ?? [])
        .filter((p) => p.manifest?.kind === "component")
        .map((p) => ({
          id: p.id,
          name: p.manifest?.name ?? p.id,
          configSchema: p.manifest?.configSchema,
        })),
    [pluginsData],
  );
  const selectedPluginId = component.plugin?.id ?? "";
  const selectedPlugin = componentPlugins.find((p) => p.id === selectedPluginId);
  const pluginItems = componentPlugins.map((p) => ({ value: p.id, label: p.name }));

  const handleSelectPlugin = (pluginId: string) => {
    if (!pluginId || pluginId === selectedPluginId) return;
    const picked = componentPlugins.find((p) => p.id === pluginId);
    onUpdate({
      plugin: { id: pluginId },
      config: seedConfigForSchema(picked?.configSchema),
    });
  };

  const updateEnvDraft = (next: DraftEnv[]) => {
    setEnvDraft(next);
    const record = draftsToRecord(next);
    const newJson = JSON.stringify(record);
    lastEmittedEnvJson.current = newJson;
    onUpdate({ env: Object.keys(record).length > 0 ? record : undefined });
  };

  const addEnvRow = () => updateEnvDraft([...envDraft, { k: "", v: "" }]);
  const removeEnvRow = (i: number) => updateEnvDraft(envDraft.filter((_, idx) => idx !== i));
  const editEnvKey = (i: number, k: string) =>
    updateEnvDraft(envDraft.map((e, idx) => (idx === i ? { ...e, k } : e)));
  const editEnvValue = (i: number, v: string) =>
    updateEnvDraft(envDraft.map((e, idx) => (idx === i ? { ...e, v } : e)));

  const toggleDep = (name: string) => {
    const current = component.dependsOn ?? [];
    const next = current.includes(name) ? current.filter((d) => d !== name) : [...current, name];
    onUpdate({ dependsOn: next.length > 0 ? next : undefined });
  };

  const portDisplay = portBase !== undefined ? String(portBase) : "";

  const rowBase =
    "flex items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 transition-colors";
  const rowIdle = "hover:bg-stone-100 dark:hover:bg-stone-800/40 group";
  const rowExpanded =
    "bg-stone-100 dark:bg-stone-800/50 border-stone-200 dark:border-stone-800 rounded-b-none border-b-transparent group";

  return (
    <div data-component-row={componentKey}>
      <div className={`${rowBase} ${isExpanded ? rowExpanded : rowIdle}`}>
        <Button
          onPress={onToggleExpand}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          aria-expanded={isExpanded}
          className="shrink-0 -m-1 p-1 rounded outline-none data-[focus-visible]:bg-stone-200 dark:data-[focus-visible]:bg-stone-800/60 text-stone-500 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
        >
          <ChevronRight
            size={12}
            className={"transition-transform duration-150 " + (isExpanded ? "rotate-90" : "")}
          />
        </Button>

        <InlineNameInput
          value={componentKey}
          onCommit={onRename}
          onReset={onResetRename}
          hasError={!!renameError}
        />

        <RoleBadge role={component.type} />

        <TextField
          value={portDisplay}
          onChange={(v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n)) onUpdatePort(n);
          }}
          aria-label="Base port"
          className="shrink-0"
        >
          <Input
            type="number"
            min={1}
            max={65535}
            placeholder="3000"
            className="w-16 text-right bg-transparent font-mono text-[12px] text-stone-500 dark:text-stone-400 border border-transparent rounded px-1.5 py-0.5 outline-none hover:border-stone-300 dark:hover:border-stone-700 focus:border-stone-400 dark:focus:border-stone-600 focus:text-stone-800 dark:focus:text-stone-200 focus:bg-stone-50 dark:focus:bg-stone-950/60"
          />
        </TextField>

        {stride > 0 && portBase !== undefined && (
          <span className="shrink-0 w-8 text-left font-mono tabular-nums text-[10px] text-stone-400 dark:text-stone-600">
            +{stride}
          </span>
        )}

        <Button
          onPress={onRequestRemove}
          aria-label={`Remove ${componentKey}`}
          className="shrink-0 p-1 rounded text-stone-400 dark:text-stone-600 opacity-0 group-hover:opacity-100 data-[focus-visible]:opacity-100 hover:text-red-400 hover:bg-stone-200/80 dark:hover:bg-stone-800/80 transition-opacity outline-none"
        >
          <Trash2 size={13} />
        </Button>
      </div>

      {renameError && <p className="ml-[38px] mt-0.5 text-[11px] text-red-400">{renameError}</p>}
      {portConflictLabel && (
        <p className="ml-[38px] mt-0.5 text-[11px] text-amber-400">{portConflictLabel}</p>
      )}

      {isExpanded && (
        <div className="ml-[21px] pl-4 pr-4 pt-3 pb-4 border-l-2 border-amber-500/35 bg-stone-50 dark:bg-stone-900/40 rounded-b-md">
          <div className="space-y-5">
            {component.type === undefined && (
              <div>
                <span className={FIELD_LABEL}>Component plugin</span>
                <div data-testid="component-plugin-select">
                  <Select
                    items={pluginItems}
                    value={selectedPluginId}
                    onChange={handleSelectPlugin}
                    placeholder="Select a component plugin"
                  />
                </div>
                {componentPlugins.length === 0 && (
                  <p className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-600">
                    No component plugins are installed. Install one from the Plugins settings to
                    bind this component.
                  </p>
                )}
                {selectedPlugin && (
                  <div className="mt-4">
                    <ConfigSchemaForm
                      schema={selectedPlugin.configSchema}
                      values={component.config ?? {}}
                      onChange={(next) => onUpdate({ config: next })}
                    />
                  </div>
                )}
              </div>
            )}

            {component.type === "process" && (
              <div>
                <TextField
                  value={component.command ?? ""}
                  onChange={(v) => onUpdate({ command: v || undefined })}
                  aria-label="Command"
                >
                  <Label className={FIELD_LABEL}>Command</Label>
                  <Input placeholder="e.g. npm run dev" className={HERO_INPUT} />
                </TextField>
                <p className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-600">
                  Runs in the bench workspace when the bench starts.
                </p>
              </div>
            )}

            {component.type === "database" && (
              <div className="space-y-1">
                <div className="grid grid-cols-5 gap-3">
                  <div className="col-span-3">
                    <TextField
                      value={component.docker?.composeFile ?? ""}
                      onChange={(v) =>
                        onUpdate({
                          docker: {
                            ...component.docker,
                            composeFile: v,
                            service: component.docker?.service ?? "",
                          },
                        })
                      }
                      aria-label="Docker compose file"
                    >
                      <Label className={FIELD_LABEL}>Docker compose file</Label>
                      <Input
                        placeholder="docker-compose.yml"
                        className={`${FIELD_INPUT} font-mono`}
                      />
                    </TextField>
                  </div>
                  <div className="col-span-2">
                    <TextField
                      value={component.docker?.service ?? ""}
                      onChange={(v) =>
                        onUpdate({
                          docker: {
                            ...component.docker,
                            composeFile: component.docker?.composeFile ?? "",
                            service: v,
                          },
                        })
                      }
                      aria-label="Docker service"
                    >
                      <Label className={FIELD_LABEL}>Service</Label>
                      <Input placeholder="e.g. postgres" className={`${FIELD_INPUT} font-mono`} />
                    </TextField>
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-600">
                  Brought up via{" "}
                  <span className="font-mono text-stone-600 dark:text-stone-500">
                    docker compose up
                  </span>
                  .
                </p>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={`${FIELD_LABEL} mb-0`}>Environment</span>
                <Button
                  onPress={addEnvRow}
                  className="inline-flex items-center gap-1 text-[11px] text-stone-500 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 outline-none transition-colors"
                >
                  <Plus size={11} /> Add variable
                </Button>
              </div>
              {envDraft.length === 0 ? (
                <p className="text-[11px] text-stone-500 dark:text-stone-700">
                  No environment variables.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {envDraft.map((entry, i) => (
                    <div key={entry.k || i} className="flex items-center gap-2 group/env">
                      <TextField
                        value={entry.k}
                        onChange={(v) => editEnvKey(i, v)}
                        aria-label={`Environment variable name ${i + 1}`}
                        className="flex-1"
                      >
                        <Input placeholder="KEY" className={`${FIELD_INPUT} font-mono`} />
                      </TextField>
                      <span className="text-stone-400 dark:text-stone-700 text-[12px]">=</span>
                      <TextField
                        value={entry.v}
                        onChange={(v) => editEnvValue(i, v)}
                        aria-label={`Environment variable value ${i + 1}`}
                        className="flex-1"
                      >
                        <Input placeholder="value" className={FIELD_INPUT} />
                      </TextField>
                      <Button
                        onPress={() => removeEnvRow(i)}
                        aria-label={`Remove environment variable ${i + 1}`}
                        className="p-1 rounded text-stone-400 dark:text-stone-600 opacity-0 group-hover/env:opacity-100 data-[focus-visible]:opacity-100 hover:text-red-400 hover:bg-stone-200/80 dark:hover:bg-stone-800/60 transition-opacity outline-none"
                      >
                        <X size={11} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <span className={FIELD_LABEL}>Depends on</span>
              {otherComponentNames.length === 0 ? (
                <p className="text-[11px] text-stone-500 dark:text-stone-700">
                  No other components.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {otherComponentNames.map((name) => {
                    const on = (component.dependsOn ?? []).includes(name);
                    return (
                      <Button
                        key={name}
                        onPress={() => toggleDep(name)}
                        aria-pressed={on}
                        className={
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-mono transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 " +
                          (on
                            ? "bg-amber-500/10 text-amber-500 border-amber-500/40 hover:bg-amber-500/15"
                            : "bg-transparent text-stone-500 border-stone-300 dark:border-stone-700 hover:text-stone-700 dark:hover:text-stone-300 hover:border-stone-400 dark:hover:border-stone-600")
                        }
                      >
                        {name}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>

            {component.type === "process" && (
              <div>
                <Button
                  onPress={() => setMoreOpen((p) => !p)}
                  aria-expanded={moreOpen}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-stone-500 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 py-1.5 outline-none transition-colors"
                >
                  <ChevronRight
                    size={11}
                    className={"transition-transform duration-150 " + (moreOpen ? "rotate-90" : "")}
                  />
                  More options
                </Button>
                {moreOpen && (
                  <div className="space-y-4 mt-2">
                    <div>
                      <TextField
                        value={component.setup ?? ""}
                        onChange={(v) => onUpdate({ setup: v || undefined })}
                        aria-label="Setup command"
                      >
                        <Label className={FIELD_LABEL}>Setup command</Label>
                        <Input placeholder="e.g. npm install" className={FIELD_INPUT} />
                      </TextField>
                      <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-600">
                        Runs once when the bench is first created.
                      </p>
                    </div>
                    <div>
                      <TextField
                        value={component.directory ?? ""}
                        onChange={(v) => onUpdate({ directory: v || undefined })}
                        aria-label="Working directory"
                      >
                        <Label className={FIELD_LABEL}>Working directory</Label>
                        <Input
                          placeholder="e.g. ./apps/api"
                          className={`${FIELD_INPUT} font-mono`}
                        />
                      </TextField>
                    </div>
                    <p className="text-[11px] text-stone-500 dark:text-stone-700 italic">
                      Migration, env file, and compose variables are preserved from YAML.
                    </p>
                  </div>
                )}
              </div>
            )}

            {component.type === "database" && (
              <p className="text-[11px] text-stone-500 dark:text-stone-700 italic">
                Init service, build env vars, and compose variables are preserved from YAML.
              </p>
            )}

            <div className="pt-2 border-t border-stone-200 dark:border-stone-800/60">
              <Button
                onPress={onRequestRemove}
                className="inline-flex items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-500 hover:text-red-400 outline-none transition-colors"
              >
                <Trash2 size={11} /> Remove component
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
