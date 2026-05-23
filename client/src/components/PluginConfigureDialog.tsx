import { useMemo, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import type {
  IntegrationConfig,
  IntegrationConfigUpdate,
  IntegrationTestResult,
  ProjectIntegrationState,
  SourceCandidatesResponse,
  SourceSelection,
} from "@roubo/shared";
import { ApiError } from "../lib/api";
import {
  useSaveIntegrationConfig,
  useTestIntegrationConnection,
} from "../hooks/useProjectIntegration";
import { useSourceCandidates } from "../hooks/useSourceCandidates";
import { useSaveProjectSources } from "../hooks/useSaveProjectSources";
import ConfigSchemaForm from "./ConfigSchemaForm";
import SourcePicker from "./SourcePicker";
import Spinner from "./Spinner";
import { passwordFieldKeys } from "./config-schema-utils";

type InstalledPlugin = NonNullable<ProjectIntegrationState["plugin"]>;

interface Props {
  projectId: string;
  plugin: InstalledPlugin;
  effective: IntegrationConfig;
}

const KNOWN_TLS_FIELD_KEYS = ["allowSelfSignedTls", "allow_self_signed_tls", "allowSelfSignedTLS"];

function findTlsFieldKey(schema: Record<string, unknown> | undefined): string | null {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) return null;
  for (const candidate of KNOWN_TLS_FIELD_KEYS) {
    if (candidate in props) return candidate;
  }
  // Last-resort scan: any boolean field whose key mentions both "tls" and "self".
  for (const [key, def] of Object.entries(props)) {
    if (
      def !== null &&
      typeof def === "object" &&
      (def as { type?: string }).type === "boolean" &&
      /tls/i.test(key) &&
      /self/i.test(key)
    ) {
      return key;
    }
  }
  return null;
}

function snapshotEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function seedInitialValues(
  schema: Record<string, unknown> | undefined,
  effective: IntegrationConfig,
): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const out: Record<string, unknown> = {};
  if (!props) return out;
  const advanced = (effective.advanced ?? {}) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(props)) {
    if (key === "instance") {
      out[key] = effective.instance ?? "";
      continue;
    }
    if (key in advanced) {
      out[key] = advanced[key];
      continue;
    }
    const def = (raw ?? {}) as { default?: unknown; type?: string };
    if (def.default !== undefined) {
      out[key] = def.default;
    } else if (def.type === "boolean") {
      out[key] = false;
    } else {
      out[key] = "";
    }
  }
  return out;
}

export default function PluginConfigureDialog({ projectId, plugin, effective }: Props) {
  // Hoist the mutations so the ModalOverlay can gate dismissal on the busy
  // state: Escape / overlay-click must not unmount the dialog mid-save or
  // mid-test, otherwise the in-flight request completes invisibly and any
  // setSubmitError surface is dropped.
  const testMutation = useTestIntegrationConnection(projectId);
  const saveMutation = useSaveIntegrationConfig(projectId);
  const saveSourcesMutation = useSaveProjectSources(projectId);
  const isBusy = testMutation.isPending || saveMutation.isPending || saveSourcesMutation.isPending;

  return (
    <ModalOverlay
      isDismissable={!isBusy}
      isKeyboardDismissDisabled={isBusy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <ConfigureFlow
              projectId={projectId}
              plugin={plugin}
              effective={effective}
              close={close}
              testMutation={testMutation}
              saveMutation={saveMutation}
              saveSourcesMutation={saveSourcesMutation}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function initialSourceSelection(effective: IntegrationConfig): SourceSelection {
  const out: SourceSelection = {};
  const raw = effective.sources;
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      out[key] = value.map(String);
    }
  }
  return out;
}

function hasAnyCandidates(data: SourceCandidatesResponse | undefined): boolean {
  if (!data) return false;
  if (data.shape === "multi-list") return (data.items?.length ?? 0) > 0;
  return (data.categories ?? []).some((cat) => cat.items.length > 0);
}

function ConfigureFlow({
  projectId,
  plugin,
  effective,
  close,
  testMutation,
  saveMutation,
  saveSourcesMutation,
}: {
  projectId: string;
  plugin: InstalledPlugin;
  effective: IntegrationConfig;
  close: () => void;
  testMutation: ReturnType<typeof useTestIntegrationConnection>;
  saveMutation: ReturnType<typeof useSaveIntegrationConfig>;
  saveSourcesMutation: ReturnType<typeof useSaveProjectSources>;
}) {
  const manifest = plugin.manifest;
  const initialValues = useMemo(
    () => seedInitialValues(manifest?.configSchema, effective),
    [manifest?.configSchema, effective],
  );
  const initialSources = useMemo(() => initialSourceSelection(effective), [effective]);

  const [values, setValuesState] = useState<Record<string, unknown>>(initialValues);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [lastTestedSnapshot, setLastTestedSnapshot] = useState<Record<string, unknown> | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceSelection>(initialSources);

  const passwordKeys = useMemo(
    () => new Set(passwordFieldKeys(manifest?.configSchema)),
    [manifest?.configSchema],
  );
  const tlsFieldKey = useMemo(
    () => findTlsFieldKey(manifest?.configSchema),
    [manifest?.configSchema],
  );

  const hasTestedSuccessfully =
    testResult?.ok === true &&
    lastTestedSnapshot !== null &&
    snapshotEquals(values, lastTestedSnapshot);

  const sourceCandidatesQuery = useSourceCandidates(
    projectId,
    hasTestedSuccessfully ? plugin.id : null,
  );

  function buildUpdate(
    snapshot: Record<string, unknown>,
    identity: IntegrationTestResult & { ok: true },
  ): IntegrationConfigUpdate {
    // Split form values: password keys live in the credential store, `instance`
    // is a top-level override key, everything else goes under `advanced`
    // (opaque-to-roubo per FR-023).
    const advanced: Record<string, unknown> = {};
    let instance: string | undefined;
    for (const [key, value] of Object.entries(snapshot)) {
      if (passwordKeys.has(key)) continue;
      if (key === "instance") {
        instance = typeof value === "string" ? value : undefined;
        continue;
      }
      advanced[key] = value;
    }
    const update: IntegrationConfigUpdate = {
      capturedUserId: identity.identity,
    };
    if (instance !== undefined) update.instance = instance;
    if (Object.keys(advanced).length > 0) update.advanced = advanced;
    return update;
  }

  function setValues(next: Record<string, unknown>) {
    setValuesState(next);
    // Any field change invalidates the previous test success — FR-034 / TC-037.
    // Reset the source selection back to whatever the override held, since the
    // candidate list is keyed to the previously-tested connection.
    setTestResult(null);
    setLastTestedSnapshot(null);
    setSources(initialSources);
  }

  async function runTest(snapshot: Record<string, unknown>) {
    setSubmitError(null);
    try {
      const result = await testMutation.mutateAsync(snapshot);
      setTestResult(result);
      if (result.ok) {
        // Commit instance + advanced + capturedUserId so the subsequent
        // listSourceCandidates fetch sees the right effective config. The test
        // endpoint already persists credentials; this brings instance/advanced
        // into line so the source picker can populate without forcing a manual
        // intermediate Save.
        try {
          await saveMutation.mutateAsync(buildUpdate(snapshot, result));
          setLastTestedSnapshot(snapshot);
        } catch (err) {
          setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
          setLastTestedSnapshot(null);
        }
      } else {
        setLastTestedSnapshot(null);
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: {
          kind: "other",
          message: err instanceof ApiError ? err.message : (err as Error).message,
        },
      });
      setLastTestedSnapshot(null);
    }
  }

  async function handleEnableTls() {
    if (!tlsFieldKey) return;
    const next = { ...values, [tlsFieldKey]: true };
    setValuesState(next);
    // Keep `testResult` showing the TLS message until the rerun completes;
    // intentionally do NOT clear here, otherwise the strip flickers blank.
    await runTest(next);
  }

  async function handleSave() {
    if (!hasTestedSuccessfully || testResult?.ok !== true) return;
    setSubmitError(null);

    // Instance/advanced + capturedUserId were already committed in `runTest`
    // when the test passed, so Save is dedicated to persisting the source
    // selection (or a no-op if the plugin doesn't expose sources).
    try {
      await saveSourcesMutation.mutateAsync(sources);
      close();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  const isBusy = testMutation.isPending || saveMutation.isPending || saveSourcesMutation.isPending;
  const showSourcesSection =
    hasTestedSuccessfully &&
    (sourceCandidatesQuery.isLoading || hasAnyCandidates(sourceCandidatesQuery.data));

  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Configure {manifest?.name ?? plugin.id}
        </Heading>
      </div>

      <div className="px-5 py-4 space-y-4">
        <ConfigSchemaForm
          schema={manifest?.configSchema}
          permissions={manifest?.permissions}
          values={values}
          onChange={setValues}
        />

        <ResultStrip
          testing={testMutation.isPending}
          result={testResult}
          tlsFieldKey={tlsFieldKey}
          onEnableTls={handleEnableTls}
        />

        {showSourcesSection && (
          <div className="flex flex-col gap-2" data-testid="sources-section">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
              Sources
            </span>
            {sourceCandidatesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
                <Spinner />
                Loading sources…
              </div>
            ) : sourceCandidatesQuery.data ? (
              <SourcePicker
                response={sourceCandidatesQuery.data}
                value={sources}
                onChange={setSources}
              />
            ) : null}
          </div>
        )}

        {submitError && (
          <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
            {submitError}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          isDisabled={isBusy}
          onPress={() => void runTest(values)}
          data-testid="test-connection"
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Test connection
        </Button>
        <div className="flex items-center gap-2">
          <Button
            isDisabled={isBusy}
            onPress={close}
            className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            Cancel
          </Button>
          <Button
            isDisabled={!hasTestedSuccessfully || isBusy}
            onPress={() => void handleSave()}
            data-testid="save-config"
            className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
          >
            {saveMutation.isPending || saveSourcesMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </>
  );
}

function ResultStrip({
  testing,
  result,
  tlsFieldKey,
  onEnableTls,
}: {
  testing: boolean;
  result: IntegrationTestResult | null;
  tlsFieldKey: string | null;
  onEnableTls: () => void;
}) {
  if (testing) {
    return (
      <div
        role="status"
        className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40"
      >
        <Loader2 size={14} className="animate-spin text-stone-500" />
        <p className="text-[12px] text-stone-600 dark:text-stone-400">Testing connection…</p>
      </div>
    );
  }
  if (!result) return null;

  if (result.ok) {
    return (
      <div
        role="status"
        data-testid="test-result-success"
        className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-950/20"
      >
        <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />
        <p className="text-[12px] text-green-800 dark:text-green-300">
          Connected as {result.identity.displayName}.
        </p>
      </div>
    );
  }

  const isTls = result.error.kind === "tls";
  return (
    <div
      role="alert"
      data-testid={`test-result-error-${result.error.kind}`}
      className="flex items-start gap-2.5 px-3 py-2 rounded-md border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20"
    >
      <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-[12px] text-red-800 dark:text-red-300 leading-relaxed">
          {result.error.message}
        </p>
        {isTls && tlsFieldKey && (
          <Button
            onPress={onEnableTls}
            data-testid="enable-self-signed-tls"
            className="px-2.5 py-1 text-[11px] font-medium rounded-md border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            Enable self-signed TLS and retry
          </Button>
        )}
      </div>
    </div>
  );
}
