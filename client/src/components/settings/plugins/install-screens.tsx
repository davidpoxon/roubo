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
      <div className="px-5 py-4 border-b border-border">
        <Heading slot="title" className="text-16 font-semibold text-text-primary">
          {title}
        </Heading>
        <p className="mt-1 text-12 text-text-secondary">{subtitle}</p>
      </div>

      <div className="px-5 py-4 space-y-4">
        <Tabs
          selectedKey={state.tab}
          onSelectionChange={(key) => onChange({ ...state, tab: key as SourceTab, error: null })}
        >
          <TabList aria-label={STRINGS.tabAriaLabel} className="flex gap-0 border-b border-border">
            {(["git", "local"] as const).map((id) => (
              <Tab
                key={id}
                id={id}
                className={({ isSelected, isFocusVisible }) =>
                  [
                    "px-4 py-2 text-13 font-medium outline-none transition-colors duration-100 -mb-px border-b-2",
                    isSelected
                      ? "text-text-primary border-accent"
                      : "text-text-secondary border-transparent hover:text-text-primary",
                    isFocusVisible
                      ? "ring-2 ring-focus-ring ring-offset-1 ring-offset-bg-base rounded-t"
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
              <Label className="block text-12 text-text-secondary mb-1.5">
                {STRINGS.repoUrlLabel}
              </Label>
              <Input
                data-testid="install-plugin-git-url"
                placeholder={STRINGS.repoUrlPlaceholder}
                className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 font-mono text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
              />
              <p className="mt-1.5 text-11 text-text-secondary">{STRINGS.repoUrlHelp}</p>
            </TextField>
          </TabPanel>

          <TabPanel id="local" className="outline-none pt-4">
            <TextField
              value={state.localInput}
              onChange={(value) => onChange({ ...state, localInput: value, error: null })}
              isDisabled={submitting}
            >
              <Label className="block text-12 text-text-secondary mb-1.5">
                {STRINGS.localPathLabel}
              </Label>
              <Input
                data-testid="install-plugin-local-path"
                placeholder={STRINGS.localPathPlaceholder}
                className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 font-mono text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
              />
              <p className="mt-1.5 text-11 text-text-secondary">
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
            className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 text-danger-text"
          >
            {state.error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
        <Button
          onPress={onCancel}
          isDisabled={submitting}
          className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {cancelLabel}
        </Button>
        <Button
          onPress={onSubmit}
          isDisabled={submitting}
          data-testid="install-plugin-submit"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active disabled:opacity-40 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {STRINGS.inspecting}
            </>
          ) : (
            <>
              <Plus size={14} />
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
      <div className="px-5 py-4 border-b border-border">
        <Heading slot="title" className="text-16 font-semibold text-text-primary">
          {STRINGS.installTitle(manifest.name, manifest.version)}
        </Heading>
        <p className="mt-1 text-12 text-text-secondary">{STRINGS.reviewPrompt}</p>
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
            className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-13 text-danger-text"
          >
            {state.error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
        <Button
          onPress={onCancel}
          isDisabled={confirming}
          data-testid="install-plugin-permissions-cancel"
          className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {STRINGS.cancel}
        </Button>
        <Button
          onPress={onConfirm}
          isDisabled={confirming}
          data-testid="install-plugin-confirm"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active disabled:opacity-40 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {confirming ? (
            <>
              <Loader2 size={14} className="animate-spin" />
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
      <div className="text-11 font-semibold uppercase tracking-label text-text-secondary">
        {label}
      </div>
      <div className="mt-1 text-13 font-mono text-text-body break-all">{value}</div>
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
    <h4 id={id} className="text-11 font-semibold uppercase tracking-label text-text-secondary">
      {children}
    </h4>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-13 text-text-secondary italic">{children}</p>;
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
            <li key={host} className="text-13 font-mono text-text-body">
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
            <li key={slot.slot} className="text-13 text-text-body">
              <span className="font-mono">{slot.slot}</span>
              <span className="ml-2 text-11 uppercase tracking-label text-text-secondary">
                {slot.scope}
              </span>
              <p className="text-12 text-text-secondary">{slot.description}</p>
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
            <li key={p} className="text-13 font-mono text-text-body">
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
            <li key={exe} className="text-13 font-mono text-text-body">
              {exe}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
