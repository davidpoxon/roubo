import { TextField, Label, Input, Button, Checkbox } from "react-aria-components";
import { Plus, X, Lock, Zap } from "lucide-react";
import type {
  ComponentConfig,
  PortConfig,
  RepoScanResult,
  ConfigValidationResult,
} from "@roubo/shared";
import Select from "../Select";
import { filePathItems } from "../filePathItems";
import TemplateInsert from "./TemplateInsert";
import TemplateHighlightInput, { TemplateValidationError } from "./TemplateHighlightInput";
import { validateTemplateVariables, type TemplateVariableContext } from "./templateDescriptions";
import { INPUT } from "./styles";

interface Props {
  component: ComponentConfig;
  portNames: string[];
  componentNames: string[];
  ports: Record<string, PortConfig>;
  components: Record<string, ComponentConfig>;
  projectName: string;
  scanResult?: RepoScanResult;
  onChange: (component: ComponentConfig) => void;
  hideComposeFile?: boolean;
  portBase: number | null;
  onPortChange: (base: number | null) => void;
  portHttps: boolean | undefined;
  onPortHttpsChange: (https: boolean) => void;
  portConflict?: ConfigValidationResult["portConflicts"][number];
  maxBenches: number;
  envFileKeys?: string[];
}

function parseConnectionPairs(template: string): Array<[string, string]> {
  if (!template) return [["", ""]];
  return template.split(";").map((seg) => {
    const eqIdx = seg.indexOf("=");
    if (eqIdx === -1) return [seg, ""] as [string, string];
    return [seg.slice(0, eqIdx), seg.slice(eqIdx + 1)] as [string, string];
  });
}

function joinConnectionPairs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k}=${v}`).join(";");
}

export default function ComponentEditor({
  component,
  portNames,
  componentNames,
  ports,
  components,
  projectName,
  scanResult,
  onChange,
  hideComposeFile,
  portBase,
  onPortChange,
  portHttps,
  onPortHttpsChange,
  portConflict,
  maxBenches,
  envFileKeys = [],
}: Props) {
  const update = (changes: Partial<ComponentConfig>) => onChange({ ...component, ...changes });
  const isType = (t: string) => component.type === t;
  const templateCtx: TemplateVariableContext = {
    portNames,
    componentNames,
    ports,
    components,
    projectName,
  };

  const showCommand = isType("process") || !!component.command;
  const showSetup = isType("process") || !!component.setup;
  const showDocker = isType("database") || !!component.docker;
  const showMigration = isType("database") || !!component.migration;
  const showConnection = isType("database") || !!component.connection;
  const showDirectory = isType("process") || !!component.directory;
  const showEnvFile = isType("process") || !!component.envFile;
  const showEnv = isType("process") || isType("database") || !!component.env;
  const showEnvVars = isType("process") || !!component.envVars;

  const rawEnvEntries = Object.entries(component.env ?? {});
  const envEntries = rawEnvEntries.length > 0 ? rawEnvEntries : [["", ""] as [string, string]];
  const rawEnvVarEntries = Object.entries(component.envVars ?? {});
  const envVarEntries =
    rawEnvVarEntries.length > 0 ? rawEnvVarEntries : [["", ""] as [string, string]];
  const connectionPairs = parseConnectionPairs(component.connection?.template ?? "");

  const detected = scanResult?.detected;
  const composeServices =
    detected?.dockerComposeServiceNames?.[component.docker?.composeFile ?? ""];
  const initServiceItems = composeServices?.filter((name) => name !== component.docker?.service);

  // Compose variables for current service + its init service (both receive the same env at runtime)
  const composeFileVars = detected?.dockerComposeVars?.[component.docker?.composeFile ?? ""];
  const primaryVars = component.docker?.service
    ? (composeFileVars?.[component.docker.service] ?? {})
    : {};
  const initVars = component.docker?.initService
    ? (composeFileVars?.[component.docker.initService] ?? {})
    : {};
  const detectedComposeVars = { ...initVars, ...primaryVars };
  const portVarName = component.docker?.service
    ? (detected?.dockerComposePortVars?.[component.docker.composeFile ?? ""]?.[
        component.docker.service
      ] ?? null)
    : null;
  const detectedVarKeys = Object.keys(detectedComposeVars);

  // Split env entries: detected (read-only key) vs custom (editable key)
  const currentEnv = component.env ?? {};
  const customVarEntries = Object.entries(currentEnv).filter(([k]) => !detectedVarKeys.includes(k));

  const portRangeInvalid = portBase !== null && (portBase < 1 || portBase > 65535);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <label className="block text-[11px] text-stone-500 dark:text-stone-600 mb-1">
          Base port
        </label>
        <div className="flex items-center gap-3">
          <TextField
            value={portBase !== null ? String(portBase) : ""}
            onChange={(v) => {
              const n = parseInt(v, 10);
              onPortChange(isNaN(n) ? null : n);
            }}
            aria-label="Base port"
          >
            <Input type="number" min={1} max={65535} placeholder="e.g. 3000" className={INPUT} />
          </TextField>
          {portBase !== null && maxBenches > 1 && (
            <span className="text-[11px] text-stone-500 dark:text-stone-600 font-mono tabular-nums">
              {portBase}–{portBase + maxBenches - 1}
            </span>
          )}
        </div>
        {portBase !== null && (
          <Checkbox
            isSelected={portHttps ?? false}
            onChange={onPortHttpsChange}
            className="flex items-center gap-1.5 text-[11px] text-stone-500 cursor-pointer select-none group"
          >
            <div className="size-3.5 rounded border border-stone-600 group-data-[selected]:bg-stone-500 group-data-[selected]:border-stone-500 transition-colors flex items-center justify-center">
              <svg
                viewBox="0 0 12 12"
                className="size-2.5 text-stone-900 opacity-0 group-data-[selected]:opacity-100 transition-opacity"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M2 6l3 3 5-5" />
              </svg>
            </div>
            HTTPS
          </Checkbox>
        )}
        {portRangeInvalid && (
          <p className="text-[11px] text-red-400 pl-0.5">Port must be between 1 and 65535</p>
        )}
        {portConflict && (
          <p className="text-[11px] text-amber-400 pl-0.5">
            Conflicts with {portConflict.conflictsWith.projectName}{" "}
            {portConflict.conflictsWith.port} ({portConflict.conflictsWith.range[0]}–
            {portConflict.conflictsWith.range[1]})
          </p>
        )}
      </div>

      {showCommand && (
        <div>
          <label className="block text-[11px] text-stone-600 mb-1">Command</label>
          <TextField
            value={component.command ?? ""}
            onChange={(v) => update({ command: v || undefined })}
            aria-label="Command"
          >
            <div className={`${INPUT} flex items-center gap-1`}>
              <TemplateHighlightInput
                value={component.command ?? ""}
                variant="inner"
                placeholder="e.g. dotnet run --project src/Api/Api.csproj"
                invalidVariables={validateTemplateVariables(component.command ?? "", templateCtx)}
              />
              <TemplateInsert
                ctx={templateCtx}
                onInsert={(v) => {
                  update({ command: (component.command ?? "") + v });
                }}
              />
            </div>
          </TextField>
          <TemplateValidationError
            invalidVariables={validateTemplateVariables(component.command ?? "", templateCtx)}
          />
          <p className="text-[10px] text-stone-500 dark:text-stone-700 mt-1">
            Executable and arguments. Supports template variables like{" "}
            <span className="font-mono">{"{{ports.name}}"}</span>.
          </p>
        </div>
      )}

      {showSetup && (
        <div>
          <label className="block text-[11px] text-stone-600 mb-1">Setup command</label>
          <TextField
            value={component.setup ?? ""}
            onChange={(v) => update({ setup: v || undefined })}
            aria-label="Setup command"
          >
            <Input placeholder="e.g. npm ci, dotnet restore" className={INPUT} />
          </TextField>
          <p className="text-[10px] text-stone-500 dark:text-stone-700 mt-1">
            Runs once during bench preparing before the component starts
          </p>
        </div>
      )}

      {showDocker && (
        <fieldset className="space-y-3">
          <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
            <span className="size-1.5 rounded-full bg-blue-400/70" />
            Docker
          </legend>
          {!hideComposeFile && (
            <div>
              <label className="block text-[11px] text-stone-500 dark:text-stone-600 mb-1">
                Compose file
              </label>
              {detected?.dockerComposeFiles.length ? (
                <Select
                  items={filePathItems(detected.dockerComposeFiles)}
                  value={component.docker?.composeFile ?? ""}
                  onChange={(value) =>
                    update({
                      docker: {
                        ...component.docker,
                        composeFile: value,
                        service: component.docker?.service ?? "",
                      },
                    })
                  }
                  placeholder="Select compose file"
                />
              ) : (
                <TextField
                  value={component.docker?.composeFile ?? ""}
                  onChange={(v) =>
                    update({
                      docker: {
                        ...component.docker,
                        composeFile: v,
                        service: component.docker?.service ?? "",
                      },
                    })
                  }
                  aria-label="Compose file"
                >
                  <Input placeholder="path/to/docker-compose.yml" className={INPUT} />
                </TextField>
              )}
            </div>
          )}
          <div>
            <label className="block text-[11px] text-stone-600 mb-1">Component name</label>
            {composeServices?.length ? (
              <Select
                items={composeServices}
                value={component.docker?.service ?? ""}
                onChange={(value) => {
                  const autoPortVar =
                    detected?.dockerComposePortVars?.[component.docker?.composeFile ?? ""]?.[value];
                  const cfVars = detected?.dockerComposeVars?.[component.docker?.composeFile ?? ""];
                  const newDetectedVars = {
                    ...(component.docker?.initService
                      ? (cfVars?.[component.docker.initService] ?? {})
                      : {}),
                    ...(cfVars?.[value] ?? {}),
                  };
                  const newEnv: Record<string, string> = {};
                  for (const [varName, defaultVal] of Object.entries(newDetectedVars)) {
                    newEnv[varName] = component.env?.[varName] ?? defaultVal ?? "";
                  }
                  // Preserve any custom (non-detected) vars the user already added
                  const prevDetectedKeys = Object.keys(detectedComposeVars);
                  for (const [k, v] of Object.entries(currentEnv)) {
                    if (!prevDetectedKeys.includes(k) && !(k in newEnv)) newEnv[k] = v;
                  }
                  update({
                    docker: {
                      ...component.docker,
                      composeFile: component.docker?.composeFile ?? "",
                      service: value,
                      portEnvVar: autoPortVar ?? component.docker?.portEnvVar,
                    },
                    env: Object.keys(newEnv).length > 0 ? newEnv : undefined,
                  });
                }}
                placeholder="Select service"
              />
            ) : (
              <TextField
                value={component.docker?.service ?? ""}
                onChange={(v) =>
                  update({
                    docker: {
                      ...component.docker,
                      composeFile: component.docker?.composeFile ?? "",
                      service: v,
                    },
                  })
                }
                aria-label="Docker service name"
              >
                <Input placeholder="e.g. sql" className={INPUT} />
              </TextField>
            )}
          </div>
          <div>
            <label className="block text-[11px] text-stone-600 mb-1">Init service</label>
            {initServiceItems?.length ? (
              <Select
                items={initServiceItems}
                value={component.docker?.initService ?? ""}
                allowClear
                onChange={(value) => {
                  const docker = {
                    composeFile: component.docker?.composeFile ?? "",
                    service: component.docker?.service ?? "",
                    initService: value || undefined,
                  };
                  update({ docker });
                }}
                placeholder="Optional"
              />
            ) : (
              <TextField
                value={component.docker?.initService ?? ""}
                onChange={(v) => {
                  const docker = {
                    composeFile: component.docker?.composeFile ?? "",
                    service: component.docker?.service ?? "",
                    initService: v || undefined,
                  };
                  update({ docker });
                }}
                aria-label="Init service"
              >
                <Input placeholder="Optional" className={INPUT} />
              </TextField>
            )}
          </div>
        </fieldset>
      )}

      {showMigration && (
        <fieldset className="space-y-3">
          <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
            <span className="size-1.5 rounded-full bg-amber-400/70" />
            Migration
          </legend>
          <TextField
            value={component.migration?.command ?? ""}
            onChange={(v) =>
              update({
                migration: {
                  command: v,
                  args: component.migration?.args ?? [""],
                },
              })
            }
          >
            <Label className="block text-[11px] text-stone-500 dark:text-stone-600 mb-1">
              Command
            </Label>
            <Input placeholder="dotnet run --project ..." className={INPUT} />
          </TextField>
          <div className="space-y-1">
            <label className="block text-[11px] text-stone-500 dark:text-stone-600">
              Arguments
            </label>
            {(component.migration?.args ?? [""]).map((arg, i) => {
              const invalidVars = validateTemplateVariables(arg, templateCtx);
              return (
                <div key={i}>
                  <div className="flex items-center gap-1">
                    <TextField
                      value={arg}
                      onChange={(v) => {
                        const args = [...(component.migration?.args ?? [""])];
                        args[i] = v;
                        update({
                          migration: {
                            command: component.migration?.command ?? "",
                            args,
                          },
                        });
                      }}
                      aria-label={`Argument ${i + 1}`}
                      className="flex-1"
                    >
                      <div className={`${INPUT} flex items-center gap-1`}>
                        <TemplateHighlightInput
                          value={arg}
                          variant="inner"
                          placeholder="e.g. {{components.app.connection}}"
                          invalidVariables={invalidVars}
                        />
                        <TemplateInsert
                          ctx={templateCtx}
                          onInsert={(v) => {
                            const args = [...(component.migration?.args ?? [""])];
                            args[i] = (args[i] ?? "") + v;
                            update({
                              migration: {
                                command: component.migration?.command ?? "",
                                args,
                              },
                            });
                          }}
                        />
                      </div>
                    </TextField>
                    <Button
                      onPress={() => {
                        const args = (component.migration?.args ?? [""]).filter((_, j) => j !== i);
                        update({
                          migration: {
                            command: component.migration?.command ?? "",
                            args: args.length > 0 ? args : [""],
                          },
                        });
                      }}
                      className="p-1 text-stone-400 dark:text-stone-600 hover:text-red-400 transition-colors shrink-0"
                    >
                      <X size={14} />
                    </Button>
                  </div>
                  <TemplateValidationError invalidVariables={invalidVars} />
                </div>
              );
            })}
            <Button
              onPress={() => {
                const args = [...(component.migration?.args ?? []), ""];
                update({
                  migration: {
                    command: component.migration?.command ?? "",
                    args,
                  },
                });
              }}
              className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-300 transition-colors"
            >
              <Plus size={12} /> Add argument
            </Button>
          </div>
        </fieldset>
      )}

      {showConnection && (
        <fieldset className="space-y-2">
          <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
            <span className="size-1.5 rounded-full bg-emerald-400/70" />
            Connection
          </legend>
          {connectionPairs.map(([key, value], i) => {
            const invalidVars = validateTemplateVariables(value, templateCtx);
            return (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <TextField
                    value={key}
                    onChange={(v) => {
                      const pairs = connectionPairs.map((p, j): [string, string] =>
                        j === i ? [v, p[1]] : p,
                      );
                      update({
                        connection: { template: joinConnectionPairs(pairs) },
                      });
                    }}
                    aria-label="Connection key"
                    className="w-1/3"
                  >
                    <Input placeholder="Key" className={INPUT} />
                  </TextField>
                  <TextField
                    value={value}
                    onChange={(v) => {
                      const pairs = connectionPairs.map((p, j): [string, string] =>
                        j === i ? [p[0], v] : p,
                      );
                      update({
                        connection: { template: joinConnectionPairs(pairs) },
                      });
                    }}
                    aria-label="Connection value"
                    className="flex-1"
                  >
                    <div className={`${INPUT} flex items-center gap-1`}>
                      <TemplateHighlightInput
                        value={value}
                        variant="inner"
                        placeholder="value"
                        invalidVariables={invalidVars}
                      />
                      <TemplateInsert
                        ctx={templateCtx}
                        onInsert={(v) => {
                          const pairs = connectionPairs.map((p, j): [string, string] =>
                            j === i ? [p[0], p[1] + v] : p,
                          );
                          update({
                            connection: {
                              template: joinConnectionPairs(pairs),
                            },
                          });
                        }}
                      />
                    </div>
                  </TextField>
                  <Button
                    onPress={() => {
                      const remaining = connectionPairs.filter((_, j) => j !== i);
                      update({
                        connection: {
                          template: joinConnectionPairs(
                            remaining.length > 0 ? remaining : [["", ""]],
                          ),
                        },
                      });
                    }}
                    className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <X size={14} />
                  </Button>
                </div>
                <TemplateValidationError invalidVariables={invalidVars} />
              </div>
            );
          })}
          <Button
            onPress={() => {
              update({
                connection: {
                  template: joinConnectionPairs([...connectionPairs, ["", ""]]),
                },
              });
            }}
            className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-300 transition-colors"
          >
            <Plus size={12} /> Add pair
          </Button>
        </fieldset>
      )}

      {showDirectory && (
        <div>
          <label className="block text-[11px] text-stone-600 mb-1">Working directory</label>
          {detected?.viteProjects.length ? (
            <Select
              items={filePathItems(detected.viteProjects)}
              value={component.directory ?? ""}
              onChange={(value) => update({ directory: value })}
              placeholder="Select directory"
            />
          ) : (
            <TextField
              value={component.directory ?? ""}
              onChange={(v) => update({ directory: v })}
              aria-label="Working directory"
            >
              <Input placeholder="frontend-dir" className={INPUT} />
            </TextField>
          )}
        </div>
      )}

      {showEnvFile && (
        <div>
          <label className="block text-[11px] text-stone-600 mb-1">Env file</label>
          {detected?.envFiles.length ? (
            <Select
              items={filePathItems(detected.envFiles)}
              value={component.envFile ?? ""}
              onChange={(value) => update({ envFile: value || undefined })}
              placeholder="Select env file"
              allowClear
            />
          ) : (
            <TextField
              value={component.envFile ?? ""}
              onChange={(v) => update({ envFile: v || undefined })}
              aria-label="Env file"
            >
              <Input placeholder=".env.development.local" className={INPUT} />
            </TextField>
          )}
        </div>
      )}

      {showEnv && isType("database") && (
        <fieldset className="space-y-2">
          <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
            <span className="size-1.5 rounded-full bg-violet-400/70" />
            Compose variables
          </legend>

          {/* Detected variables — read-only keys */}
          {detectedVarKeys.map((varName) => {
            const value = currentEnv[varName] ?? "";
            const isEnvFile = envFileKeys.includes(varName);
            const isPortVar = varName === portVarName;
            const invalidVars = validateTemplateVariables(value, templateCtx);

            return (
              <div key={varName}>
                <div className="flex items-center gap-2">
                  {/* Read-only key with inline badge */}
                  <div className="w-1/3 shrink-0">
                    <div
                      className={`${INPUT} font-mono text-stone-400 dark:text-stone-500 select-all cursor-default flex items-center gap-1.5`}
                    >
                      <span className="truncate">{varName}</span>
                      {isEnvFile && (
                        <span className="flex items-center gap-0.5 text-[10px] text-amber-400/70 font-mono leading-none shrink-0">
                          <Lock size={9} />
                          .env
                        </span>
                      )}
                      {isPortVar && !isEnvFile && (
                        <span className="flex items-center gap-0.5 text-[10px] text-blue-400/70 font-mono leading-none shrink-0">
                          <Zap size={9} />
                          port
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Editable value (or read-only if in .env) */}
                  {isEnvFile ? (
                    <div
                      className={`${INPUT} flex-1 text-stone-500 dark:text-stone-600 font-mono text-[11px] cursor-not-allowed select-none`}
                    >
                      set in ~/.roubo/.env
                    </div>
                  ) : (
                    <TextField
                      value={value}
                      onChange={(v) => update({ env: { ...currentEnv, [varName]: v } })}
                      aria-label={`Value for ${varName}`}
                      className="flex-1"
                    >
                      <div className={`${INPUT} flex items-center gap-1`}>
                        <TemplateHighlightInput
                          value={value}
                          variant="inner"
                          placeholder="value"
                          invalidVariables={invalidVars}
                        />
                        <TemplateInsert
                          ctx={templateCtx}
                          onInsert={(v) => {
                            update({
                              env: {
                                ...currentEnv,
                                [varName]: (value ?? "") + v,
                              },
                            });
                          }}
                        />
                      </div>
                    </TextField>
                  )}

                  {/* Spacer to match delete button width */}
                  <div className="size-6 shrink-0" />
                </div>
                {!isEnvFile && <TemplateValidationError invalidVariables={invalidVars} />}
              </div>
            );
          })}

          {/* Custom variables — editable keys */}
          {customVarEntries.map(([key, value], i) => {
            const invalidVars = validateTemplateVariables(value, templateCtx);
            return (
              <div key={`custom-${i}`}>
                <div className="flex items-center gap-2">
                  <TextField
                    value={key}
                    onChange={(v) => {
                      const env = { ...currentEnv };
                      Reflect.deleteProperty(env, key);
                      env[v] = value;
                      update({ env });
                    }}
                    aria-label="Variable name"
                    className="w-1/3"
                  >
                    <Input placeholder="KEY" className={`${INPUT} font-mono`} />
                  </TextField>
                  <TextField
                    value={value}
                    onChange={(v) => update({ env: { ...currentEnv, [key]: v } })}
                    aria-label="Variable value"
                    className="flex-1"
                  >
                    <div className={`${INPUT} flex items-center gap-1`}>
                      <TemplateHighlightInput
                        value={value}
                        variant="inner"
                        placeholder="value"
                        invalidVariables={invalidVars}
                      />
                      <TemplateInsert
                        ctx={templateCtx}
                        onInsert={(v) => {
                          update({
                            env: { ...currentEnv, [key]: (value ?? "") + v },
                          });
                        }}
                      />
                    </div>
                  </TextField>
                  <Button
                    onPress={() => {
                      const env = { ...currentEnv };
                      Reflect.deleteProperty(env, key);
                      const remaining = Object.keys(env).length > 0 ? env : undefined;
                      update({ env: remaining });
                    }}
                    className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <X size={14} />
                  </Button>
                </div>
                <TemplateValidationError invalidVariables={invalidVars} />
              </div>
            );
          })}

          <Button
            onPress={() => update({ env: { ...currentEnv, "": "" } })}
            className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
          >
            <Plus size={12} /> Add variable
          </Button>

          {detectedVarKeys.length === 0 && customVarEntries.length === 0 && (
            <p className="text-[10px] text-stone-600 dark:text-stone-700">
              Select a compose service above to detect variables from the compose file.
            </p>
          )}
        </fieldset>
      )}

      {showEnv && !isType("database") && (
        <fieldset className="space-y-2">
          <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
            <span className="size-1.5 rounded-full bg-violet-400/70" />
            Environment variables
          </legend>
          {envEntries.map(([key, value], i) => {
            const invalidVars = validateTemplateVariables(value, templateCtx);
            return (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <TextField
                    value={key}
                    onChange={(v) => {
                      const env = { ...component.env };
                      Reflect.deleteProperty(env, key);
                      env[v] = value;
                      update({ env });
                    }}
                    aria-label="Environment variable name"
                    className="w-1/3"
                  >
                    <Input placeholder="KEY" className={INPUT} />
                  </TextField>
                  <TextField
                    value={value}
                    onChange={(v) => update({ env: { ...component.env, [key]: v } })}
                    aria-label="Environment variable value"
                    className="flex-1"
                  >
                    <div className={`${INPUT} flex items-center gap-1`}>
                      <TemplateHighlightInput
                        value={value}
                        variant="inner"
                        placeholder="value"
                        invalidVariables={invalidVars}
                      />
                      <TemplateInsert
                        ctx={templateCtx}
                        onInsert={(v) => {
                          update({
                            env: { ...component.env, [key]: (value ?? "") + v },
                          });
                        }}
                      />
                    </div>
                  </TextField>
                  <Button
                    onPress={() => {
                      const env = { ...component.env };
                      Reflect.deleteProperty(env, key);
                      update({
                        env: Object.keys(env).length > 0 ? env : undefined,
                      });
                    }}
                    className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <X size={14} />
                  </Button>
                </div>
                <TemplateValidationError invalidVariables={invalidVars} />
              </div>
            );
          })}
          <Button
            onPress={() => update({ env: { ...component.env, "": "" } })}
            className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
          >
            <Plus size={12} /> Add variable
          </Button>
        </fieldset>
      )}

      {showEnvVars && (
        <fieldset className="space-y-2">
          <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
            <span className="size-1.5 rounded-full bg-rose-400/70" />
            Build env vars
          </legend>
          {envVarEntries.map(([key, value], i) => {
            const invalidVars = validateTemplateVariables(value, templateCtx);
            return (
              <div key={i}>
                <div className="flex items-center gap-2">
                  <TextField
                    value={key}
                    onChange={(v) => {
                      const envVars = { ...component.envVars };
                      Reflect.deleteProperty(envVars, key);
                      envVars[v] = value;
                      update({ envVars });
                    }}
                    aria-label="Build env var name"
                    className="w-1/3"
                  >
                    <Input placeholder="KEY" className={INPUT} />
                  </TextField>
                  <TextField
                    value={value}
                    onChange={(v) => update({ envVars: { ...component.envVars, [key]: v } })}
                    aria-label="Build env var value"
                    className="flex-1"
                  >
                    <div className={`${INPUT} flex items-center gap-1`}>
                      <TemplateHighlightInput
                        value={value}
                        variant="inner"
                        placeholder="value"
                        invalidVariables={invalidVars}
                      />
                      <TemplateInsert
                        ctx={templateCtx}
                        onInsert={(v) => {
                          update({
                            envVars: {
                              ...component.envVars,
                              [key]: (value ?? "") + v,
                            },
                          });
                        }}
                      />
                    </div>
                  </TextField>
                  <Button
                    onPress={() => {
                      const envVars = { ...component.envVars };
                      Reflect.deleteProperty(envVars, key);
                      update({
                        envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
                      });
                    }}
                    className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <X size={14} />
                  </Button>
                </div>
                <TemplateValidationError invalidVariables={invalidVars} />
              </div>
            );
          })}
          <Button
            onPress={() => update({ envVars: { ...component.envVars, "": "" } })}
            className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors"
          >
            <Plus size={12} /> Add variable
          </Button>
        </fieldset>
      )}

      {!showDocker &&
        !showMigration &&
        !showConnection &&
        !showCommand &&
        !showDirectory &&
        !showEnv &&
        !showEnvVars && (
          <p className="text-[11px] text-stone-400 dark:text-stone-600">
            Select a type to see relevant fields.
          </p>
        )}
    </div>
  );
}
