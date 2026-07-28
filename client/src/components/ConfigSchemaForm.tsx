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
import { Check, ChevronDown } from "lucide-react";
import type { PluginPermissions } from "@roubo/shared";
import { titleCase } from "../lib/title-case";
import { enumOptions, isPasswordProperty } from "./config-schema-utils";

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
}

function slotDescription(
  permissions: PluginPermissions | undefined,
  fieldKey: string,
): string | undefined {
  return permissions?.credentials.slots.find((s) => s.slot === fieldKey)?.description;
}

const FIELD_ERROR_CLASS = "mt-1 text-[11px] text-red-600 dark:text-red-400 leading-relaxed";

/**
 * Minimal JSON-Schema → React Aria form renderer. Handles the five field
 * shapes it is asked for: string, password-string, boolean, number/integer,
 * and a closed choice list (`enum`, or a `oneOf` of consts) rendered as a
 * select. Anything else renders a stone-500 caption explaining the field is
 * managed per project and edited in the override file rather than inline here.
 */
export default function ConfigSchemaForm({
  schema,
  permissions,
  values,
  onChange,
  errors,
}: ConfigSchemaFormProps) {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;

  if (!properties || Object.keys(properties).length === 0) {
    return (
      <p className="text-xs text-stone-500 dark:text-stone-400">
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
                <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                  {label}
                </Label>
                <Button className="w-full flex items-center justify-between px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 text-sm text-stone-900 dark:text-stone-100 outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
                  <SelectValue className="truncate data-[placeholder]:text-stone-400 dark:data-[placeholder]:text-stone-500" />
                  <ChevronDown
                    size={14}
                    className="shrink-0 ml-2 text-stone-400 dark:text-stone-600"
                  />
                </Button>
                <Popover className="w-[var(--trigger-width)] rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-xl py-1 z-50 overflow-auto max-h-60">
                  <ListBox className="outline-none">
                    {choices.map((choice) => (
                      <ListBoxItem
                        key={choice.key}
                        id={choice.key}
                        textValue={choice.label}
                        className="flex items-center justify-between px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 outline-none cursor-default data-[hovered]:bg-stone-100 dark:data-[hovered]:bg-stone-700/50 data-[focused]:bg-stone-100 dark:data-[focused]:bg-stone-700/50"
                      >
                        {({ isSelected }) => (
                          <>
                            <span className="truncate">{choice.label}</span>
                            {isSelected && (
                              <Check size={14} className="shrink-0 ml-2 text-stone-500" />
                            )}
                          </>
                        )}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Popover>
              </Select>
              {help && (
                <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                  {help}
                </p>
              )}
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
                className="flex items-center gap-2 cursor-pointer group"
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
              {help && (
                <p className="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed pl-6">
                  {help}
                </p>
              )}
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
              <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                {label}
              </Label>
              <Input
                type="number"
                className="w-full px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 text-sm text-stone-900 dark:text-stone-100 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              />
              {helpText && (
                <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                  {helpText}
                </p>
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
              <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                {label}
              </Label>
              <Input
                type={isPassword ? "password" : "text"}
                className="w-full px-3 py-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900/40 text-sm text-stone-900 dark:text-stone-100 font-mono outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              />
              {helpText && (
                <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
                  {helpText}
                </p>
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
          <p key={key} className="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
            {label} is managed per project and configured automatically. To set it by hand, edit the
            override file.
          </p>
        );
      })}
    </div>
  );
}
