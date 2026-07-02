import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { Plus } from "lucide-react";
import type { ComponentConfig, PortConfig, ConfigValidationResult } from "@roubo/shared";
import { nextAvailablePort, type WizardAction } from "./wizardReducer";
import { useProjectBenches } from "../../hooks/useBenches";
import ComponentRowEditor from "./ComponentRowEditor";
import ComponentRemoveDialog, { type ComponentBenchReference } from "./ComponentRemoveDialog";

interface Props {
  components: Record<string, ComponentConfig>;
  ports: Record<string, PortConfig>;
  maxBenches: number;
  portConflicts: ConfigValidationResult["portConflicts"];
  projectId?: string;
  dispatch: React.Dispatch<WizardAction>;
}

// A newly added component is plugin-agnostic: it carries no legacy `type`
// (#301). The binding to an installed component plugin is set elsewhere; the
// editor never seeds the deprecated `component.type` field.
function newComponentDefaults(): ComponentConfig {
  return {};
}

function allocateUniqueKey(base: string, components: Record<string, ComponentConfig>): string {
  if (!components[base]) return base;
  let n = 2;
  while (components[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

export default function ComponentsList({
  components,
  ports,
  maxBenches,
  portConflicts,
  projectId,
  dispatch,
}: Props) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});

  const { data: benches } = useProjectBenches(projectId);

  const componentEntries = Object.entries(components);

  const benchReferences = useMemo<ComponentBenchReference[]>(() => {
    if (!pendingRemove || !benches) return [];
    return benches
      .filter((b) => pendingRemove in b.components)
      .map((b) => ({ benchId: b.id, branch: b.branch }));
  }, [pendingRemove, benches]);

  const conflictForKey = (key: string) => {
    const conflict = portConflicts.find((c) => c.port === key);
    if (!conflict) return undefined;
    return `Conflicts with ${conflict.conflictsWith.projectName} ${conflict.conflictsWith.port} (${conflict.conflictsWith.range[0]}–${conflict.conflictsWith.range[1]})`;
  };

  const addComponent = () => {
    const key = allocateUniqueKey("component", components);
    dispatch({
      type: "ADD_COMPONENT",
      payload: { key, component: newComponentDefaults() },
    });
    dispatch({
      type: "ADD_PORT",
      payload: {
        key,
        port: { base: nextAvailablePort(3000, ports, maxBenches) },
      },
    });
    setExpandedKey(key);
  };

  const toggleExpand = (key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  const clearRenameError = (key: string) =>
    setRenameErrors((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== key)));

  const handleRename = (oldKey: string, newKey: string) => {
    if (newKey === oldKey) {
      clearRenameError(oldKey);
      return;
    }
    if (components[newKey]) {
      setRenameErrors((p) => ({ ...p, [oldKey]: "Name already in use" }));
      return;
    }
    clearRenameError(oldKey);
    dispatch({ type: "RENAME_COMPONENT", payload: { oldKey, newKey } });
    setExpandedKey((prev) => (prev === oldKey ? newKey : prev));
  };

  const handleUpdate = (key: string, changes: Partial<ComponentConfig>) => {
    dispatch({
      type: "UPDATE_COMPONENT",
      payload: { key, component: { ...components[key], ...changes } },
    });
  };

  const handleUpdatePort = (key: string, base: number) => {
    const current = ports[key] ?? { base: 0 };
    dispatch({
      type: "UPDATE_PORT",
      payload: { key, port: { ...current, base } },
    });
  };

  const requestRemove = (key: string) => setPendingRemove(key);

  const cancelRemove = () => setPendingRemove(null);

  const confirmRemove = () => {
    if (!pendingRemove) return;
    dispatch({ type: "REMOVE_COMPONENT", payload: pendingRemove });
    if (expandedKey === pendingRemove) setExpandedKey(null);
    setPendingRemove(null);
  };

  return (
    <div>
      {componentEntries.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-600 py-2">
          No components configured yet.
        </p>
      ) : (
        <div className="space-y-px">
          {componentEntries.map(([key, component]) => (
            <ComponentRowEditor
              key={key}
              componentKey={key}
              component={component}
              portBase={ports[key]?.base}
              maxBenches={maxBenches}
              otherComponentNames={componentEntries.map(([k]) => k).filter((k) => k !== key)}
              isExpanded={expandedKey === key}
              renameError={renameErrors[key]}
              portConflictLabel={conflictForKey(key)}
              onToggleExpand={() => toggleExpand(key)}
              onRename={(newKey) => handleRename(key, newKey)}
              onResetRename={() => clearRenameError(key)}
              onUpdate={(changes) => handleUpdate(key, changes)}
              onUpdatePort={(base) => handleUpdatePort(key, base)}
              onRequestRemove={() => requestRemove(key)}
            />
          ))}
        </div>
      )}

      <Button
        onPress={addComponent}
        className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-stone-500 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-300 outline-none transition-colors data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
      >
        <Plus size={13} /> Add component
      </Button>

      <ComponentRemoveDialog
        isOpen={pendingRemove !== null}
        componentName={pendingRemove ?? ""}
        references={benchReferences}
        onCancel={cancelRemove}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
