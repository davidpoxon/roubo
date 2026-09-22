import {
  Button,
  Checkbox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  TextField,
} from "react-aria-components";
import { useId } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { AgentChoiceProbeState, PluginPermissions } from "@roubo/shared";
import { titleCase } from "../lib/title-case";
import { enumOptions, isPasswordProperty } from "./config-schema-utils";
import {
  PROBE_FAILED_PLACEHOLDER,
  PROBE_LOADING_PLACEHOLDER,
  PROBE_LOADING_TEXT,
  probeFailureCopy,
} from "./probe-state-copy";

interface PropertyDef {
  type?: "string" | "boolean" | "number" | "integer";
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  oneOf?: unknown[];
  anyOf?: unknown[];
  allOf?: unknown[];
}

export interface ConfigSchemaFormProps {
  /** The plugin's manifest configSchema (JSON-Schema-derived). Opaque to roubo. */
  schema: Record<string, unknown> | undefined;
  /** Optional manifest permissions: credentials.slots[].description annotates password fields. */
  permissions?: PluginPermissions;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /**
   * Optional per-field validation messages, keyed by property name. Rendered
   * beneath the offending control. Server-reported errors are the source: the
   * host validates a config against the plugin's own configSchema and names the
   * field plus its allowed values.
   */
  errors?: Record<string, string>;
  /**
   * Optional choice-probe state per probed field, as the agent settings response
   * serves it (#1268). A field whose probe is `loading` or `failed` renders an
   * empty choice control with a status line instead of a free-text input: an
   * unset field already means the account default (#1274). A `resolved` field
   * needs nothing here, because its choices are already in `schema`.
   */
  probes?: Record<string, AgentChoiceProbeState>;
}

function slotDescription(
  permissions: PluginPermissions | undefined,
  fieldKey: string,
): string | undefined {
  return permissions?.credentials.slots.find((s) => s.slot === fieldKey)?.description;
}

const FIELD_ERROR_CLASS = "mt-1 text-11 text-danger-text leading-relaxed";

/**
 * A probe-bound field whose choices are not available yet (loading) or could
 * not be read (failed). The control stays in the tab order, marked
 * `aria-disabled` rather than `disabled`, so a keyboard user still reaches it
 * and hears the status line it points at (APCC-TC-023). It holds no value and
 * opens nothing, so there is no free-text entry (APCC-TC-016). The status line
 * is a `role="status"` region that persists across the loading-to-failed
 * change, so assistive technology announces the failure text (APCC-TC-022).
 */
function ProbePendingField({
  fieldKey,
  label,
  help,
  probe,
}: {
  fieldKey: string;
  label: string;
  help: string | undefined;
  probe: AgentChoiceProbeState;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const statusId = `${id}-status`;
  const helpId = `${id}-help`;
  const loading = probe.state === "loading";
  const failure = loading ? undefined : probeFailureCopy(probe.cause, probe.reason);

  return (
    <div
      className="space-y-0"
      data-testid={`config-field-${fieldKey}`}
      data-probe-state={probe.state}
    >
      <span id={labelId} className="block text-12 text-text-secondary mb-1.5">
        {label}
      </span>
      <button
        type="button"
        aria-disabled="true"
        aria-labelledby={`${labelId} ${valueId}`}
        aria-describedby={help ? `${statusId} ${helpId}` : statusId}
        className="w-full flex items-center justify-between px-3 py-1.5 rounded-control border border-border-control bg-bg-field opacity-40 text-13 text-text-secondary cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span id={valueId} className="truncate">
          {loading ? PROBE_LOADING_PLACEHOLDER : PROBE_FAILED_PLACEHOLDER}
        </span>
        <ChevronDown size={14} className="shrink-0 ml-2 text-text-secondary" />
      </button>
      <div
        id={statusId}
        role="status"
        data-testid={`config-field-${fieldKey}-probe-status`}
        className={`mt-1 flex items-start gap-1.5 text-11 leading-relaxed ${
          loading ? "text-text-secondary" : "text-danger-text"
        }`}
      >
        {loading ? (
          <>
            <Loader2 size={12} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin" />
            <span>{PROBE_LOADING_TEXT}</span>
          </>
        ) : (
          <span>
            <span className="block font-medium">{failure?.cause}</span>
            <span className="block text-text-body">{failure?.remedy}</span>
          </span>
        )}
      </div>
      {help && (
        <p id={helpId} className="mt-1 text-11 text-text-secondary leading-relaxed">
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * Minimal JSON-Schema → React Aria form renderer. Handles the five field
 * shapes it is asked for: string, password-string, boolean, number/integer,
 * and a closed choice list (`enum`, or a `oneOf` of consts) rendered as a
 * select. Anything else renders a text-secondary caption explaining the field is
 * managed per project and edited in the override file rather than inline here.
 */
export default function ConfigSchemaForm({
  schema,
  permissions,
  values,
  onChange,
  errors,
  probes,
}: ConfigSchemaFormProps) {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;

  if (!properties || Object.keys(properties).length === 0) {
    return (
      <p className="text-12 text-text-secondary">
        This plugin does not declare any configuration fields.
      </p>
    );
  }

  function setField(key: string, value: unknown) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, raw]) => {
        const def = (raw ?? {}) as PropertyDef;
        const label = def.title ?? titleCase(key);
        const help = def.description;
        const value = values[key] ?? def.default ?? "";
        const hasUnion =
          def.oneOf !== undefined || def.anyOf !== undefined || def.allOf !== undefined;
        const fieldError = errors?.[key];
        const choices = enumOptions(def);
        const probe = probes?.[key];

        if (probe && probe.state !== "resolved") {
          return (
            <div key={key} className="space-y-0">
              <ProbePendingField fieldKey={key} label={label} help={help} probe={probe} />
              {fieldError && (
                <p role="alert" className={FIELD_ERROR_CLASS}>
                  {fieldError}
                </p>
              )}
            </div>
          );
        }

        if (choices) {
          const selectedKey = value === "" ? null : String(value);
          return (
            <div key={key} className="space-y-0">
              <Select
                selectedKey={selectedKey}
                onSelectionChange={(next) => {
                  const match = choices.find((c) => c.key === String(next));
                  setField(key, match ? match.value : next);
                }}
                data-testid={`config-field-${key}`}
              >
                <Label className="block text-12 text-text-secondary mb-1.5">{label}</Label>
                <Button className="group w-full flex items-center justify-between px-3 py-1.5 rounded-control border border-border-control bg-bg-field text-13 text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring data-[pressed]:bg-bg-pressed">
                  <SelectValue className="truncate data-[placeholder]:text-text-secondary group-data-[pressed]:data-[placeholder]:text-text-body" />
                  <ChevronDown size={14} className="shrink-0 ml-2 text-text-secondary" />
                </Button>
                <Popover className="animate-rise-in w-[var(--trigger-width)] rounded-control border border-border bg-bg-surface shadow-elevation-0 py-1 z-50 overflow-auto max-h-60">
                  <ListBox className="outline-none">
                    {choices.map((choice) => (
                      <ListBoxItem
                        key={choice.key}
                        id={choice.key}
                        textValue={choice.label}
                        className="flex items-center justify-between px-3 py-1.5 text-13 text-text-body outline-none cursor-default data-[hovered]:bg-bg-hover data-[focused]:bg-bg-hover data-[selected]:text-text-primary"
                      >
                        {({ isSelected }) => (
                          <>
                            <span className="truncate">{choice.label}</span>
                            {isSelected && (
                              <Check size={14} className="shrink-0 ml-2 text-accent" />
                            )}
                          </>
                        )}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Popover>
              </Select>
              {help && <p className="mt-1 text-11 text-text-secondary leading-relaxed">{help}</p>}
              {fieldError && (
                <p role="alert" className={FIELD_ERROR_CLASS}>
                  {fieldError}
                </p>
              )}
            </div>
          );
        }

        if (def.type === "boolean") {
          const selected = Boolean(values[key] ?? def.default ?? false);
          return (
            <div key={key} className="space-y-1.5">
              <Checkbox
                isSelected={selected}
                onChange={(next) => setField(key, next)}
                aria-label={label}
                data-testid={`config-field-${key}`}
                className="flex items-center gap-2 cursor-pointer group outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {({ isSelected }) => (
                  <>
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                        isSelected ? "bg-accent border-accent" : "bg-bg-field border-border-control"
                      }`}
                    >
                      {isSelected && <Check size={12} className="text-on-accent" />}
                    </div>
                    <span className="text-13 text-text-body">{label}</span>
                  </>
                )}
              </Checkbox>
              {help && <p className="text-11 text-text-secondary leading-relaxed pl-6">{help}</p>}
              {fieldError && (
                <p role="alert" className={`${FIELD_ERROR_CLASS} pl-6`}>
                  {fieldError}
                </p>
              )}
            </div>
          );
        }

        const isPassword = isPasswordProperty(def);
        const helpText = isPassword ? (slotDescription(permissions, key) ?? help) : help;

        if (def.type === "number" || def.type === "integer") {
          return (
            <TextField
              key={key}
              value={String(value)}
              onChange={(v) => setField(key, v === "" ? undefined : Number(v))}
              data-testid={`config-field-${key}`}
            >
              <Label className="block text-12 text-text-secondary mb-1.5">{label}</Label>
              <Input
                type="number"
                className="w-full px-3 py-1.5 rounded-control border border-border-control bg-bg-field text-13 text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
              />
              {helpText && (
                <p className="mt-1 text-11 text-text-secondary leading-relaxed">{helpText}</p>
              )}
              {fieldError && (
                <p role="alert" className={FIELD_ERROR_CLASS}>
                  {fieldError}
                </p>
              )}
            </TextField>
          );
        }

        if (def.type === "string" || (def.type === undefined && !hasUnion)) {
          return (
            <TextField
              key={key}
              value={String(value)}
              onChange={(v) => setField(key, v)}
              data-testid={`config-field-${key}`}
            >
              <Label className="block text-12 text-text-secondary mb-1.5">{label}</Label>
              <Input
                type={isPassword ? "password" : "text"}
                className="w-full px-3 py-1.5 rounded-control border border-border-control bg-bg-field text-13 text-text-primary font-mono outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
              />
              {helpText && (
                <p className="mt-1 text-11 text-text-secondary leading-relaxed">{helpText}</p>
              )}
              {fieldError && (
                <p role="alert" className={FIELD_ERROR_CLASS}>
                  {fieldError}
                </p>
              )}
            </TextField>
          );
        }

        return (
          <p key={key} className="text-11 text-text-secondary leading-relaxed">
            {label} is managed per project and configured automatically. To set it by hand, edit the
            override file.
          </p>
        );
      })}
    </div>
  );
}
