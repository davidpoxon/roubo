import { RadioGroup, Radio } from "react-aria-components";
import { Zap } from "lucide-react";
import { useJigs } from "../hooks/useJigs";
import { useProjectDefaultJig, useUpdateProjectDefaultJig } from "../hooks/useProjectDefaultJig";
import Spinner from "./Spinner";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";
import type { RegisteredProject, JigDefaultSource } from "@roubo/shared";
import { OverrideBadge } from "./settings/OverrideBadge";
import Tile from "./settings/Tile";

export const INHERIT_JIG_ID = "__inherit__";

export function JigDefaultSourceLabel({ source }: { source: JigDefaultSource }) {
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

export function JigPickerOption({
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
 * Renders a jig picker for a project.
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
 *   jig controls.
 * - default: bare body with optional displayName heading and YAML footer.
 */
export function ProjectDefaultJigTile({
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
  const { data: effectiveDefault, isLoading: isLoadingDefault } = useProjectDefaultJig(project.id);
  const { data: jigs, isLoading: isLoadingJigs } = useJigs(project.id);
  const { mutate: updateDefault, isPending, isError } = useUpdateProjectDefaultJig(project.id);

  const projectDefaultId = project.config?.jigs?.defaultJig;

  // Controlled mode: use draft prop. Uncontrolled: derive from project config.
  const selectedId = isControlled
    ? (draft ?? INHERIT_JIG_ID)
    : (projectDefaultId ?? INHERIT_JIG_ID);

  const isOverridden = isControlled
    ? draft !== null && draft !== undefined
    : projectDefaultId !== undefined;

  const isLoading = isLoadingDefault || isLoadingJigs;

  const effectiveJigName = effectiveDefault
    ? (jigs?.find((b) => b.id === effectiveDefault.jigId)?.name ?? effectiveDefault.jigId)
    : null;

  const handleChange = (val: string) => {
    const newValue = val === INHERIT_JIG_ID ? null : val;
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
            {effectiveJigName}
          </span>
          {showSourceLabels && <JigDefaultSourceLabel source={effectiveDefault.source} />}
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
        aria-label="Default jig"
        className={`flex flex-col gap-2 ${!isControlled && isPending ? "opacity-60 pointer-events-none" : ""}`}
      >
        <JigPickerOption value={INHERIT_JIG_ID} label="Use app default" sublabel="No override" />
        {(jigs ?? []).map((bp) => (
          <JigPickerOption
            key={bp.id}
            value={bp.id}
            label={bp.name}
            sublabel={bp.id === GLOBAL_DEFAULT_JIG_ID ? undefined : bp.id}
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
          </span>
          . Commit alongside your other work.
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
        title="Jig"
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
