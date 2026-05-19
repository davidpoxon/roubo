import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Button,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  RadioGroup,
  Radio,
  Switch,
} from "react-aria-components";
import { Loader2, RefreshCw, Sun, Moon, Monitor, Plus } from "lucide-react";
import { useSettings, useRecheckClaudeCode } from "../hooks/useSettings";
import {
  useGlobalBlueprints,
  useDeleteGlobalBlueprint,
  useDuplicateGlobalBlueprint,
} from "../hooks/useBlueprints";
import { BlueprintPickerOption, INHERIT_BLUEPRINT_ID } from "./ProjectDefaultBlueprintTile";
import { useGitHubAuth, useConnectGitHub, useDisconnectGitHub } from "../hooks/useGitHubAuth";
import FirstNSessionsBanner from "./FirstNSessionsBanner";
import {
  DEFAULT_BLUEPRINT_SETTINGS,
  DEFAULT_BENCH_SETTINGS,
  DEFAULT_CLAUDE_CODE_SETTINGS,
  GLOBAL_DEFAULT_BLUEPRINT_ID,
} from "@roubo/shared";
import type {
  ThemeMode,
  BlueprintSettings,
  BenchSettings,
  ClaudeCodeSettings,
  BlueprintMeta,
  BlueprintReference,
} from "@roubo/shared";
import { ApiError, isBlueprintReferencedError } from "../lib/api";
import { useToast } from "../hooks/useToast";
import DeleteBlueprintDialog from "./blueprint-editor/DeleteBlueprintDialog";
import BlueprintRow from "./blueprint-editor/BlueprintRow";

function GitHubMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

const THEME_OPTIONS: {
  value: ThemeMode;
  label: string;
  Icon: typeof Sun;
  description: string;
}[] = [
  { value: "light", label: "Light", Icon: Sun, description: "Always light" },
  { value: "dark", label: "Dark", Icon: Moon, description: "Always dark" },
  {
    value: "system",
    label: "System",
    Icon: Monitor,
    description: "Follows OS",
  },
];

function SettingToggle({
  isSelected,
  onChange,
  isDisabled,
  label,
  description,
}: {
  isSelected: boolean;
  onChange: (val: boolean) => void;
  isDisabled?: boolean;
  label: string;
  description: string;
}) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      className={`group flex items-start justify-between gap-6 outline-none ${isDisabled ? "opacity-40" : ""}`}
    >
      {({ isFocusVisible }) => (
        <>
          <div className="min-w-0 flex-1">
            <div
              className={`text-sm font-medium leading-none mb-1.5 ${isDisabled ? "text-stone-500 dark:text-stone-500" : "text-stone-800 dark:text-stone-200"}`}
            >
              {label}
            </div>
            <div className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed">
              {description}
            </div>
          </div>

          <div
            className={[
              "relative shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-all duration-150",
              isSelected
                ? "bg-stone-700 dark:bg-stone-300 border-stone-700 dark:border-stone-300"
                : "bg-transparent border-stone-300 dark:border-stone-600",
              isFocusVisible
                ? "ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                : "",
            ].join(" ")}
          >
            <div
              className={[
                "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all duration-150",
                isSelected
                  ? "left-[18px] bg-white dark:bg-stone-900"
                  : "left-0.5 bg-stone-300 dark:bg-stone-600",
              ].join(" ")}
            />
          </div>
        </>
      )}
    </Switch>
  );
}

function BenchesTab() {
  const { settings, updateSettings } = useSettings();
  const benchSettings = settings?.benches ?? DEFAULT_BENCH_SETTINGS;

  const update = (patch: Partial<BenchSettings>) => {
    if (!settings) return;
    updateSettings({ ...settings, benches: { ...benchSettings, ...patch } });
  };

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-5">
          Bench Defaults
        </h3>

        <div className="space-y-6">
          <SettingToggle
            isSelected={benchSettings.autoStartComponents}
            onChange={(val) => update({ autoStartComponents: val })}
            label="Auto-start components on bench creation"
            description="When on, new benches start all components immediately. When off, click Start on the bench to launch components."
          />
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-5">
          Issue Automation
        </h3>

        <div className="space-y-6">
          <SettingToggle
            isSelected={benchSettings.autoClear}
            onChange={(val) => update({ autoClear: val })}
            label="Auto-clear completed issues"
            description="Automatically clear a bench when its assigned GitHub issue moves to Done or is closed."
          />
          <SettingToggle
            isSelected={benchSettings.enforceIssueDependencies}
            onChange={(val) => update({ enforceIssueDependencies: val })}
            label="Enforce issue dependencies"
            description="Prevent assigning issues that are blocked by unresolved dependencies."
          />
          <SettingToggle
            isSelected={benchSettings.workUnitAutoClear}
            onChange={(val) => update({ workUnitAutoClear: val })}
            isDisabled={!benchSettings.autoClear}
            label="Auto-clear meta-repo benches by PR status"
            description="Clear meta-repo benches when all work-unit pull requests are merged or closed."
          />
        </div>

        <p className="text-xs text-stone-400 dark:text-stone-600 mt-4 leading-relaxed">
          Individual projects can override auto-clear in their{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">roubo.yaml</span>{" "}
          configuration.
        </p>
      </section>
    </div>
  );
}

function BlueprintsTab() {
  const { settings, updateSettings } = useSettings();
  const { data: blueprintOptions } = useGlobalBlueprints();
  const blueprintSettings = settings?.blueprints ?? DEFAULT_BLUEPRINT_SETTINGS;
  const { addToast } = useToast();
  const navigate = useNavigate();
  const remove = useDeleteGlobalBlueprint();
  const duplicate = useDuplicateGlobalBlueprint();

  const [deletingBlueprint, setDeletingBlueprint] = useState<BlueprintMeta | null>(null);
  const [deleteReferences, setDeleteReferences] = useState<BlueprintReference[] | undefined>();

  const update = (patch: Partial<BlueprintSettings>) => {
    if (!settings) return;
    updateSettings({
      ...settings,
      blueprints: { ...blueprintSettings, ...patch },
    });
  };

  const selectedAppId = blueprintSettings.defaultBlueprintId ?? INHERIT_BLUEPRINT_ID;

  const handleDeleteConfirm = async () => {
    if (!deletingBlueprint) return;
    try {
      await remove.mutateAsync(deletingBlueprint.id);
      setDeletingBlueprint(null);
      setDeleteReferences(undefined);
      addToast("Blueprint deleted.");
    } catch (err) {
      if (isBlueprintReferencedError(err)) {
        setDeleteReferences(err.details.references);
      } else if (err instanceof ApiError) {
        addToast(err.message);
        setDeletingBlueprint(null);
      } else {
        addToast("Failed to delete blueprint.");
        setDeletingBlueprint(null);
      }
    }
  };

  const handleDuplicate = (bp: BlueprintMeta) => {
    void duplicate
      .mutateAsync({ id: bp.id })
      .then((created) => navigate(`/blueprints/edit/${created.id}`))
      .catch((err: unknown) => {
        if (err instanceof ApiError) addToast(err.message);
        else addToast("Failed to duplicate blueprint.");
      });
  };

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-5">
          Automation
        </h3>

        <div className="space-y-6">
          <SettingToggle
            isSelected={blueprintSettings.autoInject}
            onChange={(val) => update({ autoInject: val })}
            label="Auto-inject blueprint"
            description="When a Claude Code session starts, automatically inject the default blueprint into the terminal."
          />

          <div className="pl-5 border-l border-stone-200 dark:border-stone-800">
            <SettingToggle
              isSelected={blueprintSettings.autoExecute}
              onChange={(val) => update({ autoExecute: val })}
              isDisabled={!blueprintSettings.autoInject}
              label="Auto-execute"
              description="Automatically run the blueprint after injection. Turn off to review the blueprint before pressing Enter."
            />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-4">
          App Default
        </h3>
        <p className="text-xs text-stone-400 dark:text-stone-600 mb-4 leading-relaxed">
          The default blueprint used across all projects. Individual projects can override this
          below.
        </p>

        <RadioGroup
          value={selectedAppId}
          onChange={(val) =>
            update({
              defaultBlueprintId: val === INHERIT_BLUEPRINT_ID ? undefined : val,
            })
          }
          aria-label="App default blueprint"
          className="flex flex-col gap-2"
        >
          <BlueprintPickerOption
            value={INHERIT_BLUEPRINT_ID}
            label="Inherit from global default"
            sublabel="No override"
          />
          {(blueprintOptions ?? []).map((option) => (
            <BlueprintPickerOption
              key={option.id}
              value={option.id}
              label={option.name}
              sublabel={option.id === GLOBAL_DEFAULT_BLUEPRINT_ID ? undefined : option.id}
            />
          ))}
        </RadioGroup>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
            Custom Blueprints
          </h3>
          <Link
            to="/blueprints/new"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            <Plus size={12} />
            New blueprint
          </Link>
        </div>

        <div className="flex flex-col gap-2">
          {(blueprintOptions ?? [])
            .filter((bp) => bp.id !== GLOBAL_DEFAULT_BLUEPRINT_ID)
            .map((blueprint) => (
              <BlueprintRow
                key={blueprint.id}
                blueprint={blueprint}
                editHref={`/blueprints/edit/${blueprint.id}`}
                onDelete={(bp) => {
                  setDeleteReferences(undefined);
                  setDeletingBlueprint(bp);
                }}
                onDuplicate={handleDuplicate}
                isDuplicating={duplicate.isPending}
              />
            ))}
        </div>

        <p className="mt-4 text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
          App-level blueprints live in{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">
            ~/.roubo/blueprints/*.md
          </span>
          . Repo-level blueprints can also be placed in{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">
            &lt;repo&gt;/.roubo/blueprints/*.md
          </span>
          .
        </p>
      </section>

      {deletingBlueprint && (
        <DeleteBlueprintDialog
          isOpen={!!deletingBlueprint}
          blueprint={deletingBlueprint}
          onCancel={() => {
            setDeletingBlueprint(null);
            setDeleteReferences(undefined);
          }}
          onConfirm={handleDeleteConfirm}
          references={deleteReferences}
          isPending={remove.isPending}
        />
      )}
    </div>
  );
}

function ClaudeCodeTab() {
  const { settings, updateSettings } = useSettings();
  const recheck = useRecheckClaudeCode();
  const ccSettings = settings?.claudeCode ?? DEFAULT_CLAUDE_CODE_SETTINGS;
  const available = settings?.claudeCodeAutoModeAvailable ?? false;
  const reason = settings?.claudeCodeAutoModeReason;

  const update = (patch: Partial<ClaudeCodeSettings>) => {
    if (!settings) return;
    updateSettings({ ...settings, claudeCode: { ...ccSettings, ...patch } });
  };

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-5">
          Auto Mode
        </h3>

        <div className="space-y-6">
          <SettingToggle
            isSelected={ccSettings.enableAutoMode}
            onChange={(val) =>
              update(
                val ? { enableAutoMode: true } : { enableAutoMode: false, startInPlanMode: false },
              )
            }
            isDisabled={!available}
            label="Enable auto mode"
            description="Start Claude Code sessions in auto mode, allowing autonomous code changes without confirmation."
          />

          <div className="pl-5 border-l border-stone-200 dark:border-stone-800">
            <SettingToggle
              isSelected={ccSettings.startInPlanMode}
              onChange={(val) => update({ startInPlanMode: val })}
              isDisabled={!available || !ccSettings.enableAutoMode}
              label="Start in plan mode"
              description="Begin each session in plan mode, where Claude Code outlines changes before executing them."
            />
          </div>
        </div>

        <p className="text-xs text-stone-400 dark:text-stone-600 mt-4 leading-relaxed">
          Auto mode lets Claude Code make changes autonomously; plan mode requires it to outline
          changes first before executing them.{" "}
          <a
            href="https://docs.anthropic.com/en/docs/claude-code/settings#permission-modes"
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-500 dark:text-stone-400 underline hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
          >
            Learn about permission modes
          </a>
        </p>

        {!available && (
          <div className="mt-2 flex items-center gap-3">
            {reason && (
              <p className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed flex-1">
                {reason}
              </p>
            )}
            <Button
              onPress={() => recheck.mutate()}
              isDisabled={recheck.isPending}
              className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded shrink-0"
            >
              <RefreshCw className={`w-3 h-3 ${recheck.isPending ? "animate-spin" : ""}`} />
              Re-check
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function IntegrationsTab() {
  const [awaitingOAuth, setAwaitingOAuth] = useState(false);
  const { status, isLoading } = useGitHubAuth({ polling: awaitingOAuth });
  const connectGitHub = useConnectGitHub();
  const disconnectGitHub = useDisconnectGitHub();

  // Derive: only show the awaiting state while not yet connected.
  // awaitingOAuth remains true in the background once connected (polling stops via refetchInterval),
  // so we derive the visible state to avoid a setState-in-effect.
  const isAwaitingOAuth = awaitingOAuth && !status?.connected;

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-4">
          GitHub
        </h3>

        <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 overflow-hidden">
          {/* Header row */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100 dark:border-stone-800/60">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
                <GitHubMark size={16} />
              </div>
              <div>
                <p className="text-sm font-medium text-stone-800 dark:text-stone-200 leading-none mb-0.5">
                  GitHub
                </p>
                <p className="text-[11px] text-stone-400 dark:text-stone-600 leading-none">
                  Issues, projects, and pull requests
                </p>
              </div>
            </div>

            {/* Status badge */}
            {isLoading ? (
              <div className="h-5 w-20 rounded-full bg-stone-100 dark:bg-stone-800 animate-pulse" />
            ) : status?.connected ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  Connected
                </span>
              </div>
            ) : isAwaitingOAuth ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  Authorizing…
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-stone-100 dark:bg-stone-800/80 border border-stone-200 dark:border-stone-700/50">
                <div className="w-1.5 h-1.5 rounded-full bg-stone-300 dark:bg-stone-600" />
                <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400">
                  Not connected
                </span>
              </div>
            )}
          </div>

          {/* Body */}
          <div className="px-5 py-4">
            {isLoading ? (
              <div className="space-y-2">
                <div className="h-3 w-48 rounded bg-stone-100 dark:bg-stone-800 animate-pulse" />
                <div className="h-3 w-32 rounded bg-stone-100 dark:bg-stone-800 animate-pulse" />
              </div>
            ) : status?.connected ? (
              <div className="flex flex-col gap-3">
                {status.scopesOutdated && (
                  <div className="flex items-center justify-between gap-4 px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
                    <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                      Updated permissions required to load GitHub Projects.
                    </p>
                    <Button
                      onPress={() =>
                        disconnectGitHub.mutate(undefined, {
                          onSuccess: () =>
                            connectGitHub.mutate(undefined, {
                              onSuccess: () => setAwaitingOAuth(true),
                            }),
                        })
                      }
                      isDisabled={disconnectGitHub.isPending || connectGitHub.isPending}
                      className={[
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 outline-none shrink-0",
                        "bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-stone-950",
                        "focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950",
                        disconnectGitHub.isPending || connectGitHub.isPending
                          ? "opacity-60 cursor-wait"
                          : "",
                      ].join(" ")}
                    >
                      {(disconnectGitHub.isPending || connectGitHub.isPending) && (
                        <Loader2 size={12} className="animate-spin" />
                      )}
                      Reconnect
                    </Button>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-stone-500 dark:text-stone-400 mb-0.5">
                      Signed in as
                    </p>
                    <p className="text-sm font-mono font-medium text-stone-800 dark:text-stone-200">
                      {status.username ?? "unknown"}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <Button
                      onPress={() => {
                        setAwaitingOAuth(false);
                        disconnectGitHub.mutate();
                      }}
                      isDisabled={disconnectGitHub.isPending}
                      className={[
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 outline-none",
                        "text-stone-500 dark:text-stone-400 hover:text-red-500 dark:hover:text-red-400",
                        "border border-stone-200 dark:border-stone-700 hover:border-red-300 dark:hover:border-red-700",
                        "focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950",
                        disconnectGitHub.isPending ? "opacity-60 cursor-wait" : "",
                      ].join(" ")}
                    >
                      {disconnectGitHub.isPending && <Loader2 size={12} className="animate-spin" />}
                      Disconnect
                    </Button>
                    {disconnectGitHub.isError && (
                      <p className="text-xs text-red-500">
                        Could not disconnect. Please try again.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : isAwaitingOAuth ? (
              <div className="flex items-center justify-between gap-6">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Waiting for authorization in GitHub…
                  </p>
                </div>
                <Button
                  onPress={() => setAwaitingOAuth(false)}
                  className="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors duration-150 outline-none focus-visible:underline shrink-0"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-6">
                <p className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed max-w-sm">
                  Connect your GitHub account to access issues, project boards, and pull requests
                  directly in Roubo.
                </p>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Button
                    onPress={() =>
                      connectGitHub.mutate(undefined, {
                        onSuccess: () => setAwaitingOAuth(true),
                      })
                    }
                    isDisabled={connectGitHub.isPending}
                    className={[
                      "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 outline-none",
                      "bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-stone-950",
                      "focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950",
                      connectGitHub.isPending ? "opacity-60 cursor-wait" : "",
                    ].join(" ")}
                  >
                    {connectGitHub.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <GitHubMark size={14} />
                    )}
                    {connectGitHub.isPending ? "Opening…" : "Connect GitHub"}
                  </Button>
                  {connectGitHub.isError && (
                    <p className="text-xs text-red-500">Could not open GitHub. Please try again.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function AppearanceTab() {
  const { settings, updateSettings } = useSettings();
  const currentTheme = settings?.theme ?? "dark";

  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-4">
        Theme
      </h3>
      <RadioGroup
        value={currentTheme}
        onChange={(value) =>
          updateSettings({
            ...(settings ?? {
              theme: "dark" as const,
              blueprints: DEFAULT_BLUEPRINT_SETTINGS,
            }),
            theme: value as ThemeMode,
          })
        }
        aria-label="Theme mode"
        className="flex gap-3"
      >
        {THEME_OPTIONS.map(({ value, label, Icon, description }) => (
          <Radio key={value} value={value} aria-label={label} className="outline-none">
            {({ isSelected, isFocusVisible }) => (
              <div
                className={[
                  "flex flex-col items-center gap-3 px-6 py-5 rounded-xl border cursor-pointer transition-all duration-150 select-none w-32",
                  isSelected
                    ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/80 text-stone-900 dark:text-stone-100"
                    : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 text-stone-500 dark:text-stone-500 hover:border-stone-300 dark:hover:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800/40 hover:text-stone-700 dark:hover:text-stone-300",
                  isFocusVisible
                    ? "ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                    : "",
                ].join(" ")}
              >
                <Icon
                  size={20}
                  className={
                    isSelected
                      ? "text-stone-700 dark:text-stone-200"
                      : "text-stone-400 dark:text-stone-600"
                  }
                  strokeWidth={1.5}
                />
                <div className="text-center">
                  <div
                    className={`text-[13px] font-medium leading-none mb-1 ${
                      isSelected
                        ? "text-stone-900 dark:text-stone-100"
                        : "text-stone-600 dark:text-stone-400"
                    }`}
                  >
                    {label}
                  </div>
                  <div className="text-[10px] text-stone-400 dark:text-stone-600 leading-none">
                    {description}
                  </div>
                </div>
              </div>
            )}
          </Radio>
        ))}
      </RadioGroup>
    </section>
  );
}

const TAB_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  benches: "Bench Defaults",
};

export default function ProjectSettings() {
  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100 mb-6">Settings</h2>

      <FirstNSessionsBanner routeKey="global-settings" sessionCount={5} label="Settings overview">
        Application-wide defaults. Per-project settings live on each project&apos;s page.
      </FirstNSessionsBanner>

      <Tabs>
        <TabList
          aria-label="Settings sections"
          className="flex gap-0 border-b border-stone-200 dark:border-stone-800 mb-8"
        >
          {(["benches", "appearance", "blueprints", "integrations", "claude-code"] as const).map(
            (id) => (
              <Tab
                key={id}
                id={id}
                className={({ isSelected, isFocusVisible }) =>
                  [
                    "px-4 py-2.5 text-[13px] font-medium capitalize outline-none transition-colors duration-100 -mb-px border-b-2",
                    isSelected
                      ? "text-stone-900 dark:text-stone-100 border-amber-500"
                      : "text-stone-400 dark:text-stone-500 border-transparent hover:text-stone-600 dark:hover:text-stone-300",
                    isFocusVisible
                      ? "ring-2 ring-amber-500 ring-offset-1 ring-offset-white dark:ring-offset-stone-950 rounded-t"
                      : "",
                  ].join(" ")
                }
              >
                {TAB_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1)}
              </Tab>
            ),
          )}
        </TabList>

        <TabPanel id="benches" className="outline-none">
          <BenchesTab />
        </TabPanel>

        <TabPanel id="appearance" className="outline-none">
          <AppearanceTab />
        </TabPanel>

        <TabPanel id="blueprints" className="outline-none">
          <BlueprintsTab />
        </TabPanel>

        <TabPanel id="integrations" className="outline-none">
          <IntegrationsTab />
        </TabPanel>

        <TabPanel id="claude-code" className="outline-none">
          <ClaudeCodeTab />
        </TabPanel>
      </Tabs>
    </div>
  );
}
