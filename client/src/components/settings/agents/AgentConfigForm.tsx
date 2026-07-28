import { useState } from "react";
import { Button } from "react-aria-components";
import type { AgentPluginState, ConfigFieldError } from "@roubo/shared";
import ConfigSchemaForm from "../../ConfigSchemaForm";
import { useSaveAgentConfig } from "../../../hooks/useAgentPlugins";
import { ApiError } from "../../../lib/api";

const STRINGS = {
  save: "Save defaults",
  saving: "Saving...",
  reset: "Reset",
  saved: "Saved.",
  saveFailed: "Could not save. ",
  resetHint: "Reset discards unsaved edits and restores the last saved values.",
};

const PRIMARY_BUTTON_CLASS =
  "px-3 py-1 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-800 dark:text-stone-100 not-disabled:hover:bg-amber-50 not-disabled:hover:border-amber-500/40 dark:not-disabled:hover:bg-amber-950/20 disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

const SECONDARY_BUTTON_CLASS =
  "px-2.5 py-1 text-xs font-medium rounded text-stone-600 dark:text-stone-300 not-disabled:hover:bg-stone-100 not-disabled:hover:text-stone-900 dark:not-disabled:hover:bg-stone-800 dark:not-disabled:hover:text-stone-100 disabled:opacity-40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500";

function fieldErrorMap(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const details = err.details as { fieldErrors?: ConfigFieldError[] } | undefined;
  const out: Record<string, string> = {};
  for (const fieldError of details?.fieldErrors ?? []) {
    // Only the first segment addresses a rendered control; a nested path still
    // surfaces on its top-level field rather than vanishing.
    const key = fieldError.path.split(".")[0];
    if (key && !(key in out)) out[key] = fieldError.message;
  }
  return out;
}

/**
 * The schema-driven app-level config form for one agent plugin (AP-FR-003).
 *
 * `saved` is the last-persisted config the server returned; `draft` is the
 * in-progress edit. Reset is simply "draft back to saved" (AP-TC-006), and the
 * two live in this component so each card holds its own independent pair. Two
 * cards mounted side by side therefore cannot see, or overwrite, each other's
 * draft (AP-TC-009).
 */
export default function AgentConfigForm({ agent }: { agent: AgentPluginState }) {
  const [saved, setSaved] = useState<Record<string, unknown>>(agent.config);
  const [draft, setDraft] = useState<Record<string, unknown>>(agent.config);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const save = useSaveAgentConfig(agent.id);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function handleChange(next: Record<string, unknown>) {
    setDraft(next);
    setErrors({});
    setFormError(null);
    setJustSaved(false);
  }

  function handleReset() {
    setDraft(saved);
    setErrors({});
    setFormError(null);
    setJustSaved(false);
  }

  function handleSave() {
    setErrors({});
    setFormError(null);
    save.mutate(draft, {
      onSuccess: (result) => {
        setSaved(result.config);
        setDraft(result.config);
        setJustSaved(true);
      },
      onError: (err: unknown) => {
        const map = fieldErrorMap(err);
        setErrors(map);
        if (Object.keys(map).length === 0) {
          setFormError(err instanceof Error ? err.message : String(err));
        }
      },
    });
  }

  return (
    <div className="space-y-4" data-testid={`agent-config-form-${agent.id}`}>
      <ConfigSchemaForm
        schema={agent.configSchema}
        values={draft}
        onChange={handleChange}
        errors={errors}
      />

      {formError && (
        <p
          role="alert"
          className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed"
          data-testid={`agent-config-error-${agent.id}`}
        >
          {STRINGS.saveFailed}
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          onPress={handleSave}
          isDisabled={save.isPending || !dirty}
          data-testid={`agent-config-save-${agent.id}`}
          className={PRIMARY_BUTTON_CLASS}
        >
          {save.isPending ? STRINGS.saving : STRINGS.save}
        </Button>
        <Button
          onPress={handleReset}
          isDisabled={save.isPending || !dirty}
          data-testid={`agent-config-reset-${agent.id}`}
          className={SECONDARY_BUTTON_CLASS}
        >
          {STRINGS.reset}
        </Button>
        {justSaved && !dirty && (
          <span className="text-[11px] text-stone-500 dark:text-stone-400">{STRINGS.saved}</span>
        )}
      </div>

      <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
        {STRINGS.resetHint}
      </p>
    </div>
  );
}
