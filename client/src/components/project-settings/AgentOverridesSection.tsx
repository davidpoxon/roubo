import { useState } from "react";
import { Button, Checkbox } from "react-aria-components";
import { Bot, Check, Loader2 } from "lucide-react";
import type { ConfigFieldError, ProjectAgentState } from "@roubo/shared";
import ConfigSchemaForm from "../ConfigSchemaForm";
import { OverrideBadge } from "../settings/OverrideBadge";
import { titleCase } from "../../lib/title-case";
import { enumOptions } from "../config-schema-utils";
import { useProjectAgents, useSaveProjectAgentOverride } from "../../hooks/useProjectAgents";
import { ApiError } from "../../lib/api";

const STRINGS = {
  loading: "Loading agent overrides...",
  loadFailedPrefix: "Failed to load agent overrides: ",
  empty: "No agent plugins are installed, so there is nothing to override yet.",
  orphanedPrefix: "These stored overrides reference agent plugins that are not installed: ",
  orphanedSuffix:
    ". They are ignored and no configuration is resolved for them. Install the plugin, or clear the override file, to make them take effect.",
  inherit: "Inherits app default",
  override: "Override",
  appDefaultPrefix: "App default: ",
  notSet: "not set",
  effectiveLabel: "Effective:",
  effectiveHint:
    "App defaults with this project's overrides applied. Preset and per-launch settings are resolved later, at launch.",
  noFields: "This plugin does not declare any configuration fields.",
  save: "Save overrides",
  saving: "Saving...",
  reset: "Reset",
  saved: "Saved.",
  saveFailedPrefix: "Could not save. ",
};

const PRIMARY_BUTTON_CLASS =
  "px-3 py-1 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-800 dark:text-stone-100 not-disabled:hover:bg-amber-50 not-disabled:hover:border-amber-500/40 dark:not-disabled:hover:bg-amber-950/20 disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

const SECONDARY_BUTTON_CLASS =
  "px-2.5 py-1 text-xs font-medium rounded text-stone-600 dark:text-stone-300 not-disabled:hover:bg-stone-100 not-disabled:hover:text-stone-900 dark:not-disabled:hover:bg-stone-800 dark:not-disabled:hover:text-stone-100 disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

interface FieldDef {
  type?: string;
  title?: string;
  default?: unknown;
}

function schemaFields(schema: Record<string, unknown> | undefined): [string, FieldDef][] {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties) return [];
  return Object.entries(properties).map(([key, raw]) => [key, (raw ?? {}) as FieldDef]);
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return STRINGS.notSet;
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * The value an override starts at when a field is first toggled on: the app
 * default it is replacing, so switching a field to "override" never silently
 * changes what launches. Falling back through the schema default and the first
 * allowed value keeps the initial draft schema-valid even for a field the app
 * level never set.
 */
function initialOverrideValue(def: FieldDef, appDefault: unknown): unknown {
  if (appDefault !== undefined) return appDefault;
  if (def.default !== undefined) return def.default;
  const choices = enumOptions(def);
  if (choices && choices.length > 0) return choices[0].value;
  if (def.type === "boolean") return false;
  if (def.type === "number" || def.type === "integer") return 0;
  return "";
}

interface PartitionedErrors {
  /** Errors that address an overridden field, so a control exists to carry them. */
  fields: Record<string, string>;
  /** Errors with no rendered control to attach to, for the form-level banner. */
  unattached: string[];
}

/**
 * Splits the server's field errors by whether this card renders a control the
 * error can hang off. Only an OVERRIDDEN field gets a `ConfigSchemaForm`, and
 * the server validates the MERGED config rather than the override subset, so a
 * rejection can name a field this project inherits (a `required` violation, or
 * an `additionalProperties` violation naming a stale app-default key). Routing
 * those to the banner rather than dropping them is what keeps every rejection
 * visible, mirroring `partitionFieldErrors` in the app-level
 * `settings/agents/AgentConfigForm.tsx` (#634).
 */
function partitionFieldErrors(
  err: unknown,
  overriddenKeys: Record<string, unknown>,
): PartitionedErrors {
  const out: PartitionedErrors = { fields: {}, unattached: [] };
  if (!(err instanceof ApiError)) return out;
  const details = err.details as { fieldErrors?: ConfigFieldError[] } | undefined;
  for (const fieldError of details?.fieldErrors ?? []) {
    // Only the first segment addresses a rendered control; a nested path still
    // surfaces on its top-level field rather than vanishing.
    const key = fieldError.path.split(".")[0];
    if (key && Object.prototype.hasOwnProperty.call(overriddenKeys, key)) {
      if (!Object.prototype.hasOwnProperty.call(out.fields, key))
        out.fields[key] = fieldError.message;
    } else {
      out.unattached.push(fieldError.message);
    }
  }
  return out;
}

/**
 * One installed agent plugin's override rows for this project.
 *
 * The draft record holds ONLY the overridden fields, exactly like the file the
 * server writes: a key present means overridden, a key absent means inherits.
 * That makes the effective preview a plain per-field overlay of app defaults
 * and draft, and makes toggling a field off a deletion rather than a value
 * (AP-TC-005, AP-TC-016).
 */
function ProjectAgentOverrideCard({
  projectId,
  agent,
}: {
  projectId: string;
  agent: ProjectAgentState;
}) {
  const [saved, setSaved] = useState<Record<string, unknown>>(agent.overrides);
  const [draft, setDraft] = useState<Record<string, unknown>>(agent.overrides);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const save = useSaveProjectAgentOverride(projectId, agent.id);

  const fields = schemaFields(agent.configSchema);
  const effective = { ...agent.appDefaults, ...draft };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const anyOverridden = Object.keys(draft).length > 0;

  function clearFeedback() {
    setErrors({});
    setFormError(null);
    setJustSaved(false);
  }

  function toggleField(key: string, def: FieldDef, on: boolean) {
    clearFeedback();
    setDraft((prev) => {
      if (on) return { ...prev, [key]: initialOverrideValue(def, agent.appDefaults[key]) };
      // Toggling an override off drops the key entirely rather than storing a
      // null: absence IS "inherits", so the field goes back to tracking the app
      // default (AP-TC-005 S004).
      return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key));
    });
  }

  function setFieldValue(key: string, def: FieldDef, value: unknown) {
    clearFeedback();
    // An overridden field ALWAYS carries a value. `ConfigSchemaForm` emits
    // `undefined` when a number input is cleared, and storing that would leave
    // the key present but undefined: the row would still read as overridden
    // while the preview said "not set", the wire payload dropped the key, and
    // the draft compared equal to the saved state, disabling both Save and
    // Reset. Clearing therefore reverts to the value the override started at,
    // exactly as `toggleField` seeds a newly-toggled row; the way to stop
    // overriding is to untoggle the row (#637).
    setDraft((prev) => ({
      ...prev,
      [key]: value === undefined ? initialOverrideValue(def, agent.appDefaults[key]) : value,
    }));
  }

  function handleReset() {
    clearFeedback();
    setDraft(saved);
  }

  function handleSave() {
    setErrors({});
    setFormError(null);
    save.mutate(draft, {
      onSuccess: (result) => {
        setSaved(result.overrides);
        setDraft(result.overrides);
        setJustSaved(true);
      },
      onError: (err: unknown) => {
        const { fields: fieldErrors, unattached } = partitionFieldErrors(err, draft);
        setErrors(fieldErrors);
        if (unattached.length > 0) {
          // No control to render these against, so the banner carries them
          // rather than the save failing with no visible feedback at all.
          setFormError(unattached.join(", "));
        } else if (Object.keys(fieldErrors).length === 0) {
          setFormError(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  return (
    <section
      aria-label={`${agent.name} overrides`}
      data-testid={`project-agent-card-${agent.id}`}
      className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 p-4 space-y-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot size={14} className="shrink-0 text-stone-400 dark:text-stone-600" />
            <h3 className="text-sm font-medium text-stone-900 dark:text-stone-100 truncate">
              {agent.name}
            </h3>
          </div>
          <p className="mt-0.5 text-[11px] text-stone-400 dark:text-stone-600 font-mono">
            {agent.id}
          </p>
        </div>
        {anyOverridden && <OverrideBadge />}
      </header>

      {agent.unavailable && (
        <p
          role="status"
          data-testid={`project-agent-unavailable-${agent.id}`}
          className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed"
        >
          {agent.unavailable.message}
        </p>
      )}

      {fields.length === 0 ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.noFields}</p>
      ) : (
        <div className="space-y-4">
          {fields.map(([key, def]) => {
            // `hasOwnProperty.call`, not `in`: a plugin's configSchema is
            // opaque third-party data, so a property named `toString` or
            // `constructor` would otherwise read as permanently overridden and
            // could never be toggled back to inheriting.
            const overridden = Object.prototype.hasOwnProperty.call(draft, key);
            const label = def.title ?? titleCase(key);
            return (
              <div
                key={key}
                data-testid={`project-agent-field-${agent.id}-${key}`}
                className="rounded-lg border border-stone-100 dark:border-stone-800/60 px-3 py-2.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <Checkbox
                    isSelected={overridden}
                    onChange={(on) => toggleField(key, def, on)}
                    aria-label={`Override ${label}`}
                    data-testid={`project-agent-toggle-${agent.id}-${key}`}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    {({ isSelected }) => (
                      <>
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                            isSelected
                              ? "bg-stone-600 border-stone-500"
                              : "bg-stone-200 dark:bg-stone-800 border-stone-400 dark:border-stone-600"
                          }`}
                        >
                          {isSelected && <Check size={10} className="text-stone-100" />}
                        </div>
                        <span className="text-sm text-stone-700 dark:text-stone-300">{label}</span>
                      </>
                    )}
                  </Checkbox>
                  <span
                    data-testid={`project-agent-app-default-${agent.id}-${key}`}
                    className="text-[11px] text-stone-400 dark:text-stone-600 shrink-0"
                  >
                    {STRINGS.appDefaultPrefix}
                    {formatValue(agent.appDefaults[key])}
                  </span>
                </div>

                {overridden ? (
                  <ConfigSchemaForm
                    schema={{ type: "object", properties: { [key]: def } }}
                    values={{ [key]: draft[key] }}
                    onChange={(next) => setFieldValue(key, def, next[key])}
                    errors={errors}
                  />
                ) : (
                  <p
                    data-testid={`project-agent-inherits-${agent.id}-${key}`}
                    className="text-[11px] text-stone-500 dark:text-stone-400"
                  >
                    {STRINGS.inherit}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {fields.length > 0 && (
        <div
          data-testid={`project-agent-effective-${agent.id}`}
          className="rounded-lg bg-stone-50 dark:bg-stone-900/50 px-3 py-2"
        >
          <p className="text-[11px] leading-relaxed">
            <span className="text-stone-400 dark:text-stone-600">{STRINGS.effectiveLabel} </span>
            <span className="font-mono text-stone-700 dark:text-stone-300">
              {fields.map(([key]) => `${key}=${formatValue(effective[key])}`).join(", ")}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
            {STRINGS.effectiveHint}
          </p>
        </div>
      )}

      {formError && (
        <p
          role="alert"
          data-testid={`project-agent-error-${agent.id}`}
          className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed"
        >
          {STRINGS.saveFailedPrefix}
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          onPress={handleSave}
          isDisabled={save.isPending || !dirty}
          data-testid={`project-agent-save-${agent.id}`}
          className={PRIMARY_BUTTON_CLASS}
        >
          {save.isPending ? STRINGS.saving : STRINGS.save}
        </Button>
        <Button
          onPress={handleReset}
          isDisabled={save.isPending || !dirty}
          data-testid={`project-agent-reset-${agent.id}`}
          className={SECONDARY_BUTTON_CLASS}
        >
          {STRINGS.reset}
        </Button>
        {justSaved && !dirty && (
          <span className="text-[11px] text-stone-500 dark:text-stone-400">{STRINGS.saved}</span>
        )}
      </div>
    </section>
  );
}

/**
 * Project settings > Agent overrides (AP-FR-004, AP-US-002, issue #509).
 *
 * One card per installed agent plugin, one row per schema-declared field, each
 * row carrying its own inherit/override toggle and the app default it inherits.
 * An override for a plugin that is not installed is reported in a notice rather
 * than rendered as a card: nothing here fabricates a configuration for a plugin
 * the host cannot resolve (AP-TC-008).
 */
export function AgentOverridesSection({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useProjectAgents(projectId);
  const agents = data?.agents ?? [];
  const orphaned = data?.orphanedOverrides ?? [];

  return (
    <div className="space-y-3">
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
          <Loader2 size={14} className="animate-spin" />
          {STRINGS.loading}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300"
        >
          {STRINGS.loadFailedPrefix}
          {(error as Error).message}
        </div>
      )}

      {orphaned.length > 0 && (
        <p
          role="status"
          data-testid="project-agent-orphaned-overrides"
          className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed"
        >
          {STRINGS.orphanedPrefix}
          <span className="font-mono">{orphaned.map((o) => o.pluginId).join(", ")}</span>
          {STRINGS.orphanedSuffix}
        </p>
      )}

      {data && agents.length === 0 && (
        <div
          data-testid="project-agents-empty-state"
          className="rounded-xl border border-dashed border-stone-200 dark:border-stone-800 px-4 py-6 text-center"
        >
          <p className="text-xs text-stone-500 dark:text-stone-400">{STRINGS.empty}</p>
        </div>
      )}

      {agents.map((agent) => (
        <ProjectAgentOverrideCard key={agent.id} projectId={projectId} agent={agent} />
      ))}
    </div>
  );
}
