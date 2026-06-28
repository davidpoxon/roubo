import { useId } from "react";
import {
  Button,
  Heading,
  Input,
  Label,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
} from "react-aria-components";
import { Loader2, Plus } from "lucide-react";
import type { PluginManifest } from "@roubo/shared";
import type { PermissionsStep, SourceStep, SourceTab } from "./install-screens-state";

const STRINGS = {
  defaultTitle: "Install plugin",
  defaultCancelLabel: "Cancel",
  defaultSubmitLabel: "Install",
  tabAriaLabel: "Install source",
  tabGit: "Git URL",
  tabLocal: "Local directory",
  repoUrlLabel: "Repository URL",
  repoUrlPlaceholder: "https://github.com/owner/plugin.git",
  repoUrlHelp: "Public https or ssh URLs only. Authentication uses your existing git config.",
  localPathLabel: "Absolute path",
  localPathPlaceholder: "/Users/you/dev/my-plugin",
  localPathHelpPrefix: "The directory must contain a ",
  localPathHelpSuffix: " manifest.",
  inspecting: "Inspecting...",
  installTitle: (name: string, version: string) => `Install ${name} ${version}?`,
  reviewPrompt:
    "This plugin is requesting the following permissions. Review them carefully before continuing.",
  sourceLabelGit: "Git URL",
  sourceLabelLocal: "Local path",
  sourceLabelRelease: "Release asset",
  cancel: "Cancel",
  installing: "Installing...",
  installAndEnable: "Install and enable",
  noneRequested: "None requested.",
  notRequested: "Not requested.",
  networkHostsHeading: "Network hosts",
  credentialsHeading: "Credentials",
  filesystemHeading: "Filesystem paths",
  childProcessesHeading: "Child processes",
  manifestFilename: "roubo-plugin.yaml",
  defaultSubtitle: (
    <>
      Install an integration plugin from a Git repository or a local directory. The plugin will be
      cloned into <span className="font-mono">~/.roubo/plugins/</span> after you review its
      requested permissions.
    </>
  ),
};

export function SourceScreen({
  state,
  onChange,
  onCancel,
  onSubmit,
  submitting,
  title = STRINGS.defaultTitle,
  subtitle = STRINGS.defaultSubtitle,
  cancelLabel = STRINGS.defaultCancelLabel,
  submitLabel = STRINGS.defaultSubmitLabel,
}: {
  state: SourceStep;
  onChange: (next: SourceStep) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitting: boolean;
  title?: string;
  subtitle?: React.ReactNode;
  cancelLabel?: string;
  submitLabel?: string;
}) {
  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          {title}
        </Heading>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{subtitle}</p>
      </div>

      <div className="px-5 py-4 space-y-4">
        <Tabs
          selectedKey={state.tab}
          onSelectionChange={(key) => onChange({ ...state, tab: key as SourceTab, error: null })}
        >
          <TabList
            aria-label={STRINGS.tabAriaLabel}
            className="flex gap-0 border-b border-stone-200 dark:border-stone-800"
          >
            {(["git", "local"] as const).map((id) => (
              <Tab
                key={id}
                id={id}
                className={({ isSelected, isFocusVisible }) =>
                  [
                    "px-4 py-2 text-[13px] font-medium outline-none transition-colors duration-100 -mb-px border-b-2",
                    isSelected
                      ? "text-stone-900 dark:text-stone-100 border-amber-500"
                      : "text-stone-400 dark:text-stone-500 border-transparent hover:text-stone-600 dark:hover:text-stone-300",
                    isFocusVisible
                      ? "ring-2 ring-amber-500 ring-offset-1 ring-offset-white dark:ring-offset-stone-950 rounded-t"
                      : "",
                  ].join(" ")
                }
              >
                {id === "git" ? STRINGS.tabGit : STRINGS.tabLocal}
              </Tab>
            ))}
          </TabList>

          <TabPanel id="git" className="outline-none pt-4">
            <TextField
              value={state.gitInput}
              onChange={(value) => onChange({ ...state, gitInput: value, error: null })}
              isDisabled={submitting}
            >
              <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                {STRINGS.repoUrlLabel}
              </Label>
              <Input
                data-testid="install-plugin-git-url"
                placeholder={STRINGS.repoUrlPlaceholder}
                className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm font-mono text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <p className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-500">
                {STRINGS.repoUrlHelp}
              </p>
            </TextField>
          </TabPanel>

          <TabPanel id="local" className="outline-none pt-4">
            <TextField
              value={state.localInput}
              onChange={(value) => onChange({ ...state, localInput: value, error: null })}
              isDisabled={submitting}
            >
              <Label className="block text-xs text-stone-500 dark:text-stone-400 mb-1.5">
                {STRINGS.localPathLabel}
              </Label>
              <Input
                data-testid="install-plugin-local-path"
                placeholder={STRINGS.localPathPlaceholder}
                className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm font-mono text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <p className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-500">
                {STRINGS.localPathHelpPrefix}
                <span className="font-mono">{STRINGS.manifestFilename}</span>
                {STRINGS.localPathHelpSuffix}
              </p>
            </TextField>
          </TabPanel>
        </Tabs>

        {state.error && (
          <div
            role="alert"
            data-testid="install-plugin-error"
            className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300"
          >
            {state.error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          onPress={onCancel}
          isDisabled={submitting}
          className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {cancelLabel}
        </Button>
        <Button
          onPress={onSubmit}
          isDisabled={submitting}
          data-testid="install-plugin-submit"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-100 bg-stone-700 dark:bg-stone-700 hover:bg-stone-600 dark:hover:bg-stone-600 disabled:opacity-60 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {submitting ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              {STRINGS.inspecting}
            </>
          ) : (
            <>
              <Plus size={13} />
              {submitLabel}
            </>
          )}
        </Button>
      </div>
    </>
  );
}

export function PermissionsScreen({
  state,
  onCancel,
  onConfirm,
  confirming,
}: {
  state: PermissionsStep;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const { manifest, source } = state.preview;
  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          {STRINGS.installTitle(manifest.name, manifest.version)}
        </Heading>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{STRINGS.reviewPrompt}</p>
      </div>

      <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
        <SourceRow
          label={
            source.type === "git"
              ? STRINGS.sourceLabelGit
              : source.type === "release"
                ? STRINGS.sourceLabelRelease
                : STRINGS.sourceLabelLocal
          }
          value={
            source.type === "git"
              ? source.url
              : source.type === "release"
                ? source.assetUrl
                : source.path
          }
        />

        <PermissionsList manifest={manifest} />

        {state.error && (
          <div
            role="alert"
            data-testid="install-plugin-error"
            className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-[13px] text-red-700 dark:text-red-300"
          >
            {state.error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          onPress={onCancel}
          isDisabled={confirming}
          data-testid="install-plugin-permissions-cancel"
          className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {STRINGS.cancel}
        </Button>
        <Button
          onPress={onConfirm}
          isDisabled={confirming}
          data-testid="install-plugin-confirm"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-60 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {confirming ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              {STRINGS.installing}
            </>
          ) : (
            STRINGS.installAndEnable
          )}
        </Button>
      </div>
    </>
  );
}

function SourceRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {label}
      </div>
      <div className="mt-1 text-[13px] font-mono text-stone-800 dark:text-stone-200 break-all">
        {value}
      </div>
    </div>
  );
}

function PermissionsList({ manifest }: { manifest: PluginManifest }) {
  return (
    <div className="space-y-4">
      <NetworkSection hosts={manifest.permissions.network.hosts} />
      <CredentialsSection slots={manifest.permissions.credentials.slots} />
      <FilesystemSection paths={manifest.permissions.filesystem.paths} />
      <ProcessesSection processes={manifest.permissions.processes} />
    </div>
  );
}

function CategoryHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h4
      id={id}
      className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400"
    >
      {children}
    </h4>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-500 italic">{children}</p>;
}

function NetworkSection({ hosts }: { hosts: string[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <CategoryHeading id={id}>{STRINGS.networkHostsHeading}</CategoryHeading>
      {hosts.length === 0 ? (
        <EmptyHint>{STRINGS.noneRequested}</EmptyHint>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {hosts.map((host) => (
            <li key={host} className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
              {host}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CredentialsSection({
  slots,
}: {
  slots: PluginManifest["permissions"]["credentials"]["slots"];
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <CategoryHeading id={id}>{STRINGS.credentialsHeading}</CategoryHeading>
      {slots.length === 0 ? (
        <EmptyHint>{STRINGS.noneRequested}</EmptyHint>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {slots.map((slot) => (
            <li key={slot.slot} className="text-[13px] text-stone-800 dark:text-stone-200">
              <span className="font-mono">{slot.slot}</span>
              <span className="ml-2 text-[11px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
                {slot.scope}
              </span>
              <p className="text-xs text-stone-500 dark:text-stone-400">{slot.description}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilesystemSection({ paths }: { paths: string[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <CategoryHeading id={id}>{STRINGS.filesystemHeading}</CategoryHeading>
      {paths.length === 0 ? (
        <EmptyHint>{STRINGS.noneRequested}</EmptyHint>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {paths.map((p) => (
            <li key={p} className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
              {p}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProcessesSection({
  processes,
}: {
  processes: PluginManifest["permissions"]["processes"];
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <CategoryHeading id={id}>{STRINGS.childProcessesHeading}</CategoryHeading>
      {processes === false ? (
        <EmptyHint>{STRINGS.notRequested}</EmptyHint>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {processes.executables.map((exe) => (
            <li key={exe} className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
              {exe}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
