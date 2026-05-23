import { useMemo, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import type {
  IntegrationConfig,
  IntegrationConfigUpdate,
  IntegrationTestResult,
  ProjectIntegrationState,
} from "@roubo/shared";
import { ApiError } from "../lib/api";
import {
  useSaveIntegrationConfig,
  useTestIntegrationConnection,
} from "../hooks/useProjectIntegration";
import ConfigSchemaForm from "./ConfigSchemaForm";
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
  return (
    <ModalOverlay
      isDismissable
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
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ConfigureFlow({ projectId, plugin, effective, close }: Props & { close: () => void }) {
  const manifest = plugin.manifest;
  const initialValues = useMemo(
    () => seedInitialValues(manifest?.configSchema, effective),
    [manifest?.configSchema, effective],
  );

  const [values, setValuesState] = useState<Record<string, unknown>>(initialValues);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [lastTestedSnapshot, setLastTestedSnapshot] = useState<Record<string, unknown> | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const testMutation = useTestIntegrationConnection(projectId);
  const saveMutation = useSaveIntegrationConfig(projectId);

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

  function setValues(next: Record<string, unknown>) {
    setValuesState(next);
    // Any field change invalidates the previous test success — FR-034 / TC-037.
    setTestResult(null);
    setLastTestedSnapshot(null);
  }

  async function runTest(snapshot: Record<string, unknown>) {
    setSubmitError(null);
    try {
      const result = await testMutation.mutateAsync(snapshot);
      setTestResult(result);
      if (result.ok) {
        setLastTestedSnapshot(snapshot);
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

    // Split form values: keys that are configSchema password fields stay in
    // the credential store (already persisted on the last successful test).
    // `instance` is a top-level override key; everything else goes under
    // `advanced` (opaque-to-roubo per FR-023).
    const advanced: Record<string, unknown> = {};
    let instance: string | undefined;
    for (const [key, value] of Object.entries(values)) {
      if (passwordKeys.has(key)) continue;
      if (key === "instance") {
        instance = typeof value === "string" ? value : undefined;
        continue;
      }
      advanced[key] = value;
    }

    const update: IntegrationConfigUpdate = {
      capturedUserId: testResult.identity,
    };
    if (instance !== undefined) update.instance = instance;
    if (Object.keys(advanced).length > 0) update.advanced = advanced;

    try {
      await saveMutation.mutateAsync(update);
      close();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  const isBusy = testMutation.isPending || saveMutation.isPending;

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
            {saveMutation.isPending ? "Saving…" : "Save"}
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
