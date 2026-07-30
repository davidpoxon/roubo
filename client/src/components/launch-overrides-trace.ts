// The resolution trace behind the per-launch override dialog (AP-FR-011, issue
// #518).
//
// The four layers a launch resolves through, in the order the host resolves
// them: application defaults, project overrides, the preset, then this launch.
// Later layers win per field, exactly as `resolveEffectiveAgentConfig` merges
// them server-side, so the panel describes what the launch will actually do
// rather than a parallel model of it.
//
// Pure and synchronous by design. The dialog holds every layer already (a
// `ProjectAgentState` carries `appDefaults` and `overrides` separately, a
// `ResolvedAgentPreset` carries `params`), so the trace needs no round-trip and
// opening the dialog does no I/O at all (AP-NFR-002, AP-TC-049 S003).

/** The layer ids, lowest first. The array order IS the resolution order. */
export const RESOLUTION_LAYER_IDS = ["app", "project", "preset", "perLaunch"] as const;

export type ResolutionLayerId = (typeof RESOLUTION_LAYER_IDS)[number];

const LAYER_LABELS: Record<ResolutionLayerId, string> = {
  app: "app default",
  project: "project",
  preset: "preset",
  perLaunch: "this launch",
};

export interface ResolutionEntry {
  key: string;
  value: string;
  /**
   * A higher layer sets this same key, so this value never reaches the launch.
   * The dialog dims a superseded value and leaves a surviving one legible, which
   * is what makes "model resolves from the project layer because this launch
   * left it untouched" readable off the panel (AP-TC-036 S001-O03).
   */
  superseded: boolean;
}

export interface ResolutionLayer {
  id: ResolutionLayerId;
  label: string;
  entries: ResolutionEntry[];
}

export interface ResolutionTrace {
  /** Contributing layers, lowest first, with `perLaunch` always last. */
  layers: ResolutionLayer[];
  /** What the launch resolves to, scalars only. */
  effective: Record<string, string>;
}

export interface ResolutionTraceInput {
  /** The agent's application-level defaults. */
  appDefaults: Record<string, unknown>;
  /** Only the fields this project overrides; an absent key inherits. */
  projectOverrides: Record<string, unknown>;
  /** The preset's params, when a preset contributes to this launch. */
  presetParams?: Record<string, unknown>;
  /** The dialog's draft: the transient top layer, never persisted. */
  perLaunch: Record<string, unknown>;
}

/**
 * Scalars only, as `describeEffectiveParams` does. A trace line is a summary,
 * not a config viewer, so an object- or array-valued key is left out rather than
 * rendered as `[object Object]`. An empty string is a non-value: it is how the
 * dialog spells "inherit".
 */
function scalarEntries(config: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(config)
    .filter(
      (pair): pair is [string, string | number | boolean] =>
        typeof pair[1] === "string" || typeof pair[1] === "number" || typeof pair[1] === "boolean",
    )
    .map(([key, value]) => ({ key, value: String(value) }))
    .filter((entry) => entry.value.length > 0);
}

/**
 * The ordered trace for one prospective launch.
 *
 * `app` and `perLaunch` always appear: the first is where resolution starts and
 * the second is what the dialog is for, so neither may go missing even when it
 * contributes nothing. `project` and `preset` appear only when they actually
 * contribute a field, so a bare launch against an unoverridden agent reads as
 * two lines instead of four empty ones.
 */
export function buildResolutionTrace(input: ResolutionTraceInput): ResolutionTrace {
  const byLayer: Record<ResolutionLayerId, { key: string; value: string }[]> = {
    app: scalarEntries(input.appDefaults),
    project: scalarEntries(input.projectOverrides),
    preset: scalarEntries(input.presetParams ?? {}),
    perLaunch: scalarEntries(input.perLaunch),
  };

  const effective: Record<string, string> = {};
  for (const id of RESOLUTION_LAYER_IDS) {
    for (const entry of byLayer[id]) effective[entry.key] = entry.value;
  }

  const layers: ResolutionLayer[] = [];
  for (const [index, id] of RESOLUTION_LAYER_IDS.entries()) {
    const entries = byLayer[id];
    const alwaysShown = id === "app" || id === "perLaunch";
    if (entries.length === 0 && !alwaysShown) continue;
    // Superseded is decided by the layers ABOVE this one, so the same key set on
    // two layers reads as one dimmed value and one live one.
    const above = RESOLUTION_LAYER_IDS.slice(index + 1).flatMap((higher) => byLayer[higher]);
    layers.push({
      id,
      label: LAYER_LABELS[id],
      entries: entries.map((entry) => ({
        ...entry,
        superseded: above.some((higher) => higher.key === entry.key),
      })),
    });
  }

  return { layers, effective };
}
