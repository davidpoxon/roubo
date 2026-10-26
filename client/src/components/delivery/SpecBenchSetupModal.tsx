import { useState } from "react";
import {
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Button,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { AlertTriangle, Check, FileText, Workflow } from "lucide-react";
import type { SpecBenchBindMode } from "@roubo/shared";
import { stampAriaModal } from "../../lib/aria-modal";
import { useTestbenchSpecs } from "../../hooks/useTestbenchSpecs";
import { useSpecBenchSpecSummary } from "../../hooks/useSpecBenchSpecSummary";
import type { DiscoveredSpec } from "../../lib/api";
import Spinner from "../Spinner";

// The two ways a Spec Bench binds to its delivery (SB-FR-001, SB-FR-002).
const MODES: Array<{ id: SpecBenchBindMode; label: string; description: string }> = [
  { id: "launch", label: "Launch", description: "Start a new delivery of this spec" },
  { id: "attach", label: "Attach", description: "Join a delivery that already runs" },
];

// The spec folder a Spec Bench binds to: the folder of the discovered spec's
// test-cases.json.
function specFolderOf(spec: DiscoveredSpec): string {
  return spec.path.replace(/[\\/]test-cases\.json$/, "");
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

const ROW_CLASS = (selected: boolean) =>
  `w-full flex items-start gap-3 px-3 py-2.5 rounded-control border text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
    selected
      ? "border-accent-border bg-accent-muted"
      : "border-border hover:border-border-strong hover:bg-bg-hover"
  }`;

// The Set up Spec Bench dialog (SB-FR-001, SB-US-001): pick a spec of the
// project, choose how the bench binds to its delivery, read the spec, the mode
// and a summary of the spec's units and gates, then confirm. Confirm calls
// onConfirm with the spec folder and the mode, and the host owns the create
// call. Dismissal never calls onConfirm.
export default function SpecBenchSetupModal({
  isOpen,
  onClose,
  projectId,
  onConfirm,
  isCreating = false,
  error = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onConfirm: (focusedSpecPath: string, mode: SpecBenchBindMode) => void;
  isCreating?: boolean;
  error?: string | null;
}) {
  const specsQuery = useTestbenchSpecs(projectId, isOpen);
  const specs = (specsQuery.data?.specs ?? []).filter((spec) => !spec.lifecycle.archived);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<SpecBenchBindMode | null>(null);
  const selected = specs.find((spec) => spec.path === selectedPath) ?? null;
  const summary = useSpecBenchSpecSummary(projectId, isOpen && selected ? selected.slug : null);
  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? null;

  const handleClose = () => {
    setSelectedPath(null);
    setMode(null);
    onClose();
  };

  const canConfirm = selected !== null && mode !== null && summary.isSuccess && !isCreating;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-lg mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          <div className="px-5 py-4 border-b border-border">
            <Heading
              slot="title"
              className="flex items-center gap-2 text-16 font-semibold text-text-primary"
            >
              <Workflow size={16} className="text-accent-text" />
              Set up Spec Bench
            </Heading>
            <p className="mt-1 text-12 text-text-secondary">
              Choose a specification and how the bench binds to its delivery.
            </p>
          </div>

          <div className="px-5 py-4 space-y-5 max-h-[60vh] overflow-y-auto">
            <div className="space-y-2">
              <p className="text-12 font-medium text-text-secondary">Specification</p>
              {specsQuery.isLoading && (
                <div className="flex items-center gap-2 text-13 text-text-secondary py-3">
                  <Spinner />
                  Discovering specs...
                </div>
              )}
              {specsQuery.isError && (
                <p className="flex items-start gap-1.5 text-12 text-danger-text">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden />
                  <span>{specsQuery.error.message}</span>
                </p>
              )}
              {specsQuery.isSuccess && specs.length === 0 && (
                <p className="text-13 text-text-secondary">
                  No specs found in this project&apos;s{" "}
                  <code className="font-mono">.specifications</code> folder.
                </p>
              )}
              {specs.length > 0 && (
                <ToggleButtonGroup
                  aria-label="Specifications"
                  selectionMode="single"
                  selectedKeys={selectedPath ? [selectedPath] : []}
                  onSelectionChange={(keys) => {
                    const next = [...keys][0];
                    setSelectedPath(typeof next === "string" ? next : null);
                  }}
                  className="flex flex-col gap-2"
                >
                  {specs.map((spec) => (
                    <ToggleButton
                      key={spec.path}
                      id={spec.path}
                      className={ROW_CLASS(spec.path === selectedPath)}
                    >
                      <FileText size={14} className="shrink-0 mt-0.5 text-text-secondary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-13 font-medium text-text-primary">
                          {spec.slug}
                        </span>
                        <span className="block text-11 font-mono truncate text-text-secondary">
                          {specFolderOf(spec)}
                        </span>
                      </span>
                      {spec.path === selectedPath && (
                        <Check size={14} className="text-accent shrink-0 mt-0.5" />
                      )}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-12 font-medium text-text-secondary">Mode</p>
              <ToggleButtonGroup
                aria-label="Mode"
                selectionMode="single"
                selectedKeys={mode ? [mode] : []}
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  setMode(next === "launch" || next === "attach" ? next : null);
                }}
                className="grid grid-cols-2 gap-2"
              >
                {MODES.map((m) => (
                  <ToggleButton key={m.id} id={m.id} className={ROW_CLASS(m.id === mode)}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-13 font-medium text-text-primary">{m.label}</span>
                      <span className="block text-11 text-text-secondary">{m.description}</span>
                    </span>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>

            {selected && (
              <section
                aria-label="Summary"
                className="rounded-control border border-border px-3 py-2.5 space-y-1 text-12"
              >
                <p>
                  <span className="text-text-secondary">Spec </span>
                  <span data-testid="specbench-setup-summary-spec" className="font-mono text-text-primary">
                    {selected.slug}
                  </span>
                </p>
                <p>
                  <span className="text-text-secondary">Mode </span>
                  <span data-testid="specbench-setup-summary-mode" className="text-text-primary">
                    {modeLabel ?? "not chosen"}
                  </span>
                </p>
                <p data-testid="specbench-setup-summary">
                  <span className="text-text-secondary">Plan </span>
                  {summary.isLoading && <span className="text-text-secondary">Reading...</span>}
                  {summary.isError && (
                    <span className="text-danger-text">{summary.error.message}</span>
                  )}
                  {summary.data && (
                    <span className="text-text-primary">
                      {plural(summary.data.units, "unit")}, {plural(summary.data.gates, "gate")}
                    </span>
                  )}
                </p>
              </section>
            )}

            <div aria-live="polite">
              {error && (
                <p className="flex items-start gap-1.5 text-12 text-danger-text">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden />
                  <span>{error}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
            <Button
              onPress={handleClose}
              className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
            >
              Cancel
            </Button>
            <Button
              onPress={() => {
                if (selected && mode) onConfirm(specFolderOf(selected), mode);
              }}
              isDisabled={!canConfirm}
              className="flex items-center gap-1.5 px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface not-disabled:active:bg-accent-active"
            >
              {isCreating && <Spinner />}
              {isCreating ? "Confirming..." : "Confirm"}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
