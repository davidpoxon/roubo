import { RadioGroup, Radio } from "react-aria-components";
import { Zap } from "lucide-react";
import { useBlueprints } from "../hooks/useBlueprints";
import {
  useProjectDefaultBlueprint,
  useUpdateProjectDefaultBlueprint,
} from "../hooks/useProjectDefaultBlueprint";
import Spinner from "./Spinner";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type { RegisteredProject, BlueprintDefaultSource } from "@roubo/shared";
import { OverrideBadge } from "./settings/OverrideBadge";
import Tile from "./settings/Tile";

export const INHERIT_BLUEPRINT_ID = "__inherit__";

export function BlueprintDefaultSourceLabel({ source }: { source: BlueprintDefaultSource }) {
  if (source === "project") {
    return (
      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">
        From project settings
      </span>
    );
  }
  if (source === "app") {
    return (
      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
        From app settings
      </span>
    );
  }
  return (
    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-900 text-stone-400 dark:text-stone-600">
      Global default
    </span>
  );
}

export function BlueprintPickerOption({
  label,
  sublabel,
  value,
}: {
  label: string;
  sublabel?: string;
  value: string;
}) {
  return (
    <Radio value={value} className="outline-none">
      {({ isSelected, isFocusVisible }) => (
        <div
          className={[
            "flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all duration-150 cursor-pointer select-none",
            isSelected
              ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/80"
              : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 hover:border-stone-300 dark:hover:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800/40",
            isFocusVisible
              ? "ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
              : "",
          ].join(" ")}
        >
          <div
            className={[
              "w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-all duration-150",
              isSelected
                ? "border-stone-700 dark:border-stone-300 bg-stone-700 dark:bg-stone-300"
                : "border-stone-300 dark:border-stone-600",
            ].join(" ")}
          />
          <span
            className={`text-sm font-medium ${isSelected ? "text-stone-900 dark:text-stone-100" : "text-stone-600 dark:text-stone-400"}`}
          >
            {label}
          </span>
          {sublabel && (
            <span className="ml-auto text-[11px] font-mono text-stone-400 dark:text-stone-600">
              {sublabel}
            </span>
          )}
        </div>
      )}
    </Radio>
  );
}

/**
 * Renders a blueprint picker for a project.
 *
 * Two modes:
 * - Controlled (project Settings overview): pass `draft` + `onChange`; the
 *   parent batches and commits changes via the sticky Save bar.
 * - Uncontrolled / auto-save (global app Settings page): omit `draft` and
 *   `onChange`; the tile calls the mutation directly on selection change.
 *
 * Layout variants:
 * - `asTile`: wraps the body in a `Tile` card.
 * - `embedded`: returns just the picker body (no Tile wrap, no displayName,
 *   no YAML-write footer) so a parent Tile can host it alongside other
 *   blueprint controls.
 * - default: bare body with optional displayName heading and YAML footer.
 */
export function ProjectDefaultBlueprintTile({
  project,
  showProjectName = true,
  asTile = false,
  embedded = false,
  draft,
  onChange,
}: {
  project: RegisteredProject;
  showProjectName?: boolean;
  asTile?: boolean;
  embedded?: boolean;
  draft?: string | null;
  onChange?: (v: string | null) => void;
}) {
  const isControlled = onChange !== undefined;

  const displayName = project.config?.project?.displayName ?? project.id;
  const { data: effectiveDefault, isLoading: isLoadingDefault } = useProjectDefaultBlueprint(
    project.id,
  );
  const { data: blueprints, isLoading: isLoadingBlueprints } = useBlueprints(project.id);
  const {
    mutate: updateDefault,
    isPending,
    isError,
  } = useUpdateProjectDefaultBlueprint(project.id);

  const projectDefaultId = project.config?.blueprints?.defaultBlueprint;

  // Controlled mode: use draft prop. Uncontrolled: derive from project config.
  const selectedId = isControlled
    ? (draft ?? INHERIT_BLUEPRINT_ID)
    : (projectDefaultId ?? INHERIT_BLUEPRINT_ID);

  const isOverridden = isControlled
    ? draft !== null && draft !== undefined
    : projectDefaultId !== undefined;

  const isLoading = isLoadingDefault || isLoadingBlueprints;

  const effectiveBlueprintName = effectiveDefault
    ? (blueprints?.find((b) => b.id === effectiveDefault.blueprintId)?.name ??
      effectiveDefault.blueprintId)
    : null;

  const handleChange = (val: string) => {
    const newValue = val === INHERIT_BLUEPRINT_ID ? null : val;
    if (onChange) {
      onChange(newValue);
    } else {
      updateDefault(newValue);
    }
  };

  const showSourceLabels = !asTile && !embedded;

  const body = (
    <>
      {!isLoading && effectiveDefault && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-stone-400 dark:text-stone-600">Effective:</span>
          <span
            className={`text-xs font-medium ${isOverridden ? "text-amber-500 dark:text-amber-400" : "text-stone-700 dark:text-stone-300"}`}
          >
            {effectiveBlueprintName}
          </span>
          {showSourceLabels && <BlueprintDefaultSourceLabel source={effectiveDefault.source} />}
          {showSourceLabels && isOverridden && <OverrideBadge />}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600 mb-3">
          <Spinner />
          Loading...
        </div>
      )}

      <RadioGroup
        value={selectedId}
        onChange={(val) => handleChange(val)}
        aria-label="Default blueprint"
        className={`flex flex-col gap-2 ${!isControlled && isPending ? "opacity-60 pointer-events-none" : ""}`}
      >
        <BlueprintPickerOption
          value={INHERIT_BLUEPRINT_ID}
          label="Use app default"
          sublabel="No override"
        />
        {(blueprints ?? []).map((bp) => (
          <BlueprintPickerOption
            key={bp.id}
            value={bp.id}
            label={bp.name}
            sublabel={bp.id === GLOBAL_DEFAULT_BLUEPRINT_ID ? undefined : bp.id}
          />
        ))}
      </RadioGroup>

      {!isControlled && isError && (
        <p className="mt-2 text-sm text-red-500 dark:text-red-400">
          Failed to save. Please try again.
        </p>
      )}

      {!embedded && (
        <p className="text-[11px] text-stone-400 dark:text-stone-600 mt-3 leading-relaxed">
          Changes write to{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">
            {"<repo>/.roubo/roubo.yaml"}
          </span>{" "}
          — commit alongside your other work.
        </p>
      )}
    </>
  );

  if (embedded) {
    return body;
  }

  if (asTile) {
    return (
      <Tile
        icon={<Zap size={13} aria-hidden />}
        title="Blueprint"
        isOverridden={isOverridden}
        headerAction={isOverridden ? <OverrideBadge /> : undefined}
      >
        {body}
      </Tile>
    );
  }

  return (
    <div className="mb-8">
      {showProjectName && (
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-3">
          {displayName}
        </h4>
      )}
      {body}
    </div>
  );
}
