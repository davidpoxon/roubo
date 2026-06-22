import { useState } from "react";
import { useNavigate, Link, useLocation } from "react-router-dom";
import {
  Button,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  RadioGroup,
  Radio,
  Switch,
  TextField,
  Input,
} from "react-aria-components";
import { RefreshCw, Sun, Moon, Monitor, Plus } from "lucide-react";
import { useSettings, useRecheckClaudeCode } from "../hooks/useSettings";
import { useGlobalJigs, useDeleteGlobalJig, useDuplicateGlobalJig } from "../hooks/useJigs";
import { JigPickerOption, INHERIT_JIG_ID } from "./ProjectDefaultJigTile";
import FirstNSessionsBanner from "./FirstNSessionsBanner";
import {
  DEFAULT_JIG_SETTINGS,
  DEFAULT_BENCH_SETTINGS,
  DEFAULT_TESTBENCH_SETTINGS,
  DEFAULT_CLAUDE_CODE_SETTINGS,
  GLOBAL_DEFAULT_JIG_ID,
} from "@roubo/shared";
import type {
  ThemeMode,
  JigSettings,
  BenchSettings,
  ClaudeCodeSettings,
  JigMeta,
  JigReference,
} from "@roubo/shared";
import { ApiError, isJigReferencedError } from "../lib/api";
import { useToast } from "../hooks/useToast";
import DeleteJigDialog from "./jig-editor/DeleteJigDialog";
import JigRow from "./jig-editor/JigRow";
import PluginsTab from "./settings/plugins/PluginsTab";
import Marketplace from "./marketplace/Marketplace";
import { INPUT } from "./setup/styles";

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

const LIMIT_MODES: {
  value: "unlimited" | "limit";
  label: string;
  description: string;
}[] = [
  { value: "unlimited", label: "Unlimited", description: "No cap" },
  { value: "limit", label: "Limit", description: "Set a maximum" },
];

const LIMIT_ERROR = "Enter a whole number of 1 or more.";

function parseLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function GlobalBenchLimitSection({
  cap,
  onChange,
}: {
  cap?: number;
  onChange: (value: number | null) => void;
}) {
  const [mode, setMode] = useState<"unlimited" | "limit">(cap != null ? "limit" : "unlimited");
  const [text, setText] = useState(cap != null ? String(cap) : "5");
  const [error, setError] = useState<string | null>(null);

  const handleMode = (value: string) => {
    if (value === "unlimited") {
      setMode("unlimited");
      setError(null);
      onChange(null);
      return;
    }
    setMode("limit");
    const n = parseLimit(text);
    if (n != null) {
      setError(null);
      onChange(n);
    } else {
      setError(LIMIT_ERROR);
    }
  };

  const handleText = (value: string) => {
    setText(value);
    setError(parseLimit(value) == null ? LIMIT_ERROR : null);
  };

  const commit = () => {
    if (mode !== "limit") return;
    const n = parseLimit(text);
    if (n != null) onChange(n);
  };

  const disabled = mode === "unlimited";

  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-2">
        Global bench limit
      </h3>
      <p className="text-xs text-stone-400 dark:text-stone-600 mb-5 leading-relaxed">
        Cap the total number of initialised benches across every project. Per-project limits in{" "}
        <span className="font-mono text-stone-500 dark:text-stone-500">roubo.yaml</span> still
        apply.
      </p>

      <RadioGroup
        value={mode}
        onChange={handleMode}
        aria-label="Global bench limit"
        className="flex gap-3"
      >
        {LIMIT_MODES.map(({ value, label, description }) => (
          <Radio key={value} value={value} aria-label={label} className="outline-none">
            {({ isSelected, isFocusVisible }) => (
              <div
                className={[
                  "flex flex-col gap-1 px-5 py-4 rounded-xl border cursor-pointer transition-all duration-150 select-none w-40",
                  isSelected
                    ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/80"
                    : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 hover:border-stone-300 dark:hover:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800/40",
                  isFocusVisible
                    ? "ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
                    : "",
                ].join(" ")}
              >
                <div
                  className={`text-[13px] font-medium leading-none ${
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
            )}
          </Radio>
        ))}
      </RadioGroup>

      <div className="mt-5">
        <div className="flex items-center gap-3">
          <TextField
            value={disabled ? "" : text}
            onChange={handleText}
            isDisabled={disabled}
            isInvalid={!disabled && error != null}
            aria-label="Maximum benches"
            className="w-28"
          >
            <Input
              inputMode="numeric"
              placeholder="5"
              onBlur={commit}
              className={`${INPUT} ${disabled ? "opacity-40" : ""}`}
            />
          </TextField>
          <span
            className={`text-xs ${disabled ? "text-stone-300 dark:text-stone-700" : "text-stone-400 dark:text-stone-600"}`}
          >
            benches
          </span>
        </div>
        {!disabled && error != null && (
          <p role="alert" className="text-[12px] text-red-500 dark:text-red-400 mt-2">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function BenchesTab() {
  const { settings, updateSettings } = useSettings();
  const benchSettings = settings?.benches ?? DEFAULT_BENCH_SETTINGS;

  const update = (patch: Partial<BenchSettings>) => {
    if (!settings) return;
    updateSettings({ ...settings, benches: { ...benchSettings, ...patch } });
  };

  const setMaxGlobal = (value: number | null) => {
    if (!settings) return;
    const next: BenchSettings = { ...benchSettings };
    if (value == null) delete next.maxGlobal;
    else next.maxGlobal = value;
    updateSettings({ ...settings, benches: next });
  };

  return (
    <div className="space-y-10">
      <GlobalBenchLimitSection
        key={benchSettings.maxGlobal ?? "unlimited"}
        cap={benchSettings.maxGlobal}
        onChange={setMaxGlobal}
      />

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
            isSelected={benchSettings.enforceIssueDependencies}
            onChange={(val) => update({ enforceIssueDependencies: val })}
            label="Enforce issue dependencies"
            description="Prevent assigning issues that are blocked by unresolved dependencies."
          />
        </div>

        <p className="text-xs text-stone-400 dark:text-stone-600 mt-4 leading-relaxed">
          Individual projects can override this in their{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">roubo.yaml</span>{" "}
          configuration.
        </p>
      </section>
    </div>
  );
}

function JigsTab() {
  const { settings, updateSettings } = useSettings();
  const { data: jigOptions } = useGlobalJigs();
  const jigSettings = settings?.jigs ?? DEFAULT_JIG_SETTINGS;
  const { addToast } = useToast();
  const navigate = useNavigate();
  const remove = useDeleteGlobalJig();
  const duplicate = useDuplicateGlobalJig();

  const [deletingJig, setDeletingJig] = useState<JigMeta | null>(null);
  const [deleteReferences, setDeleteReferences] = useState<JigReference[] | undefined>();

  const update = (patch: Partial<JigSettings>) => {
    if (!settings) return;
    updateSettings({
      ...settings,
      jigs: { ...jigSettings, ...patch },
    });
  };

  const selectedAppId = jigSettings.defaultJigId ?? INHERIT_JIG_ID;

  const handleDeleteConfirm = async () => {
    if (!deletingJig) return;
    try {
      await remove.mutateAsync(deletingJig.id);
      setDeletingJig(null);
      setDeleteReferences(undefined);
      addToast("Jig deleted.");
    } catch (err) {
      if (isJigReferencedError(err)) {
        setDeleteReferences(err.details.references);
      } else if (err instanceof ApiError) {
        addToast(err.message);
        setDeletingJig(null);
      } else {
        addToast("Failed to delete jig.");
        setDeletingJig(null);
      }
    }
  };

  const handleDuplicate = (bp: JigMeta) => {
    void duplicate
      .mutateAsync({ id: bp.id })
      .then((created) => navigate(`/jigs/edit/${created.id}`))
      .catch((err: unknown) => {
        if (err instanceof ApiError) addToast(err.message);
        else addToast("Failed to duplicate jig.");
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
            isSelected={jigSettings.autoInject}
            onChange={(val) => update({ autoInject: val })}
            label="Auto-inject jig"
            description="When a Claude Code session starts, automatically inject the default jig into the terminal."
          />

          <div className="pl-5 border-l border-stone-200 dark:border-stone-800">
            <SettingToggle
              isSelected={jigSettings.autoExecute}
              onChange={(val) => update({ autoExecute: val })}
              isDisabled={!jigSettings.autoInject}
              label="Auto-execute"
              description="Automatically run the jig after injection. Turn off to review the jig before pressing Enter."
            />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-4">
          App Default
        </h3>
        <p className="text-xs text-stone-400 dark:text-stone-600 mb-4 leading-relaxed">
          The default jig used across all projects. Individual projects can override this below.
        </p>

        <RadioGroup
          value={selectedAppId}
          onChange={(val) =>
            update({
              defaultJigId: val === INHERIT_JIG_ID ? undefined : val,
            })
          }
          aria-label="App default jig"
          className="flex flex-col gap-2"
        >
          <JigPickerOption
            value={INHERIT_JIG_ID}
            label="Inherit from global default"
            sublabel="No override"
          />
          {(jigOptions ?? []).map((option) => (
            <JigPickerOption
              key={option.id}
              value={option.id}
              label={option.name}
              sublabel={option.id === GLOBAL_DEFAULT_JIG_ID ? undefined : option.id}
            />
          ))}
        </RadioGroup>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
            Custom Jigs
          </h3>
          <Link
            to="/jigs/new"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            <Plus size={12} />
            New jig
          </Link>
        </div>

        <div className="flex flex-col gap-2">
          {(jigOptions ?? [])
            .filter((bp) => bp.id !== GLOBAL_DEFAULT_JIG_ID)
            .map((jig) => (
              <JigRow
                key={jig.id}
                jig={jig}
                editHref={`/jigs/edit/${jig.id}`}
                onDelete={(bp) => {
                  setDeleteReferences(undefined);
                  setDeletingJig(bp);
                }}
                onDuplicate={handleDuplicate}
                isDuplicating={duplicate.isPending}
              />
            ))}
        </div>

        <p className="mt-4 text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
          App-level jigs live in{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">~/.roubo/jigs/*.md</span>.
          Repo-level jigs can also be placed in{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">
            &lt;repo&gt;/.roubo/jigs/*.md
          </span>
          .
        </p>
      </section>

      {deletingJig && (
        <DeleteJigDialog
          isOpen={!!deletingJig}
          jig={deletingJig}
          onCancel={() => {
            setDeletingJig(null);
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

function TestBenchTab() {
  const { settings, updateSettings } = useSettings();
  const testBenchSettings = settings?.testBench ?? DEFAULT_TESTBENCH_SETTINGS;
  const enabled = testBenchSettings.enabled;

  const setEnabled = (val: boolean) => {
    if (!settings) return;
    updateSettings({ ...settings, testBench: { ...testBenchSettings, enabled: val } });
  };

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500 mb-5">
          Feature
        </h3>

        <div className="space-y-6">
          <SettingToggle
            isSelected={enabled}
            onChange={setEnabled}
            label="Enable TestBench"
            description="Surface the TestBench feature: the create-TestBench option and the TestBench review surface."
          />
        </div>

        {!enabled && (
          <p className="text-xs text-stone-400 dark:text-stone-600 mt-4 leading-relaxed">
            Disabled. The create-TestBench option and the TestBench surface are hidden.
          </p>
        )}
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
              jigs: DEFAULT_JIG_SETTINGS,
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
  benches: "Benches",
  testbench: "TestBench",
};

const HASH_TAB_IDS = new Set([
  "benches",
  "testbench",
  "appearance",
  "jigs",
  "plugins",
  "marketplace",
  "claude-code",
]);

export default function ProjectSettings() {
  const { hash } = useLocation();
  // Allow deep links like /settings#plugins to pre-select a tab on mount
  // (e.g. the rolled-back migration banner sends users here).
  const initialTab =
    hash.startsWith("#") && HASH_TAB_IDS.has(hash.slice(1)) ? hash.slice(1) : undefined;

  return (
    <div className="p-8 w-full">
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100 mb-6">Settings</h2>

      <FirstNSessionsBanner routeKey="global-settings" sessionCount={5} label="Settings overview">
        Application-wide defaults. Per-project settings live on each project&apos;s page.
      </FirstNSessionsBanner>

      <Tabs defaultSelectedKey={initialTab}>
        <TabList
          aria-label="Settings sections"
          className="flex gap-0 border-b border-stone-200 dark:border-stone-800 mb-8"
        >
          {(
            [
              "benches",
              "testbench",
              "appearance",
              "jigs",
              "plugins",
              "marketplace",
              "claude-code",
            ] as const
          ).map((id) => (
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
          ))}
        </TabList>

        <TabPanel id="benches" className="outline-none">
          <BenchesTab />
        </TabPanel>

        <TabPanel id="testbench" className="outline-none">
          <TestBenchTab />
        </TabPanel>

        <TabPanel id="appearance" className="outline-none">
          <AppearanceTab />
        </TabPanel>

        <TabPanel id="jigs" className="outline-none">
          <JigsTab />
        </TabPanel>

        <TabPanel id="plugins" className="outline-none">
          <PluginsTab />
        </TabPanel>

        <TabPanel id="marketplace" className="outline-none">
          <Marketplace />
        </TabPanel>

        <TabPanel id="claude-code" className="outline-none">
          <ClaudeCodeTab />
        </TabPanel>
      </Tabs>
    </div>
  );
}
