import { Checkbox, Input, Label, TextField } from "react-aria-components";
import { Check } from "lucide-react";
import type { PluginPermissions } from "@roubo/shared";
import { titleCase } from "../lib/title-case";
import { isPasswordProperty } from "./config-schema-utils";

interface PropertyDef {
  type?: "string" | "boolean" | "number" | "integer";
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
}

export interface ConfigSchemaFormProps {
  /** The plugin's manifest configSchema (JSON-Schema-derived). Opaque to roubo. */
  schema: Record<string, unknown> | undefined;
  /** Optional manifest permissions: credentials.slots[].description annotates password fields. */
  permissions?: PluginPermissions;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

function slotDescription(
  permissions: PluginPermissions | undefined,
  fieldKey: string,
): string | undefined {
  return permissions?.credentials.slots.find((s) => s.slot === fieldKey)?.description;
}

/**
 * Minimal JSON-Schema → React Aria form renderer. Handles the four field
 * shapes WU-012 needs: string, password-string, boolean, number/integer.
 * Anything else renders a stone-500 caption pointing the user at the
 * override file.
 */
export default function ConfigSchemaForm({
  schema,
  permissions,
  values,
  onChange,
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
            </TextField>
          );
        }

        if (def.type === "string" || def.type === undefined) {
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
            </TextField>
          );
        }

        return (
          <p key={key} className="text-[11px] text-stone-500 dark:text-stone-400 leading-relaxed">
            Field {label} uses an unsupported type and must be edited in the override file.
          </p>
        );
      })}
    </div>
  );
}
