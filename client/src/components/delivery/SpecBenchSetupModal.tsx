import { useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { AlertTriangle, Workflow } from "lucide-react";
import type { SpecBenchBindMode, SpecBenchDecisionMode } from "@roubo/shared";
import { DEFAULT_SPEC_BENCH_DECISION_MODE } from "@roubo/shared";
import { DELIVERY_RECORD_FILE } from "@roubo/shared/delivery-bench";
import { stampAriaModal } from "../../lib/aria-modal";
import { useTestbenchSpecs } from "../../hooks/useTestbenchSpecs";
import { useSpecBenchSpecSummary } from "../../hooks/useSpecBenchSpecSummary";
import type { DiscoveredSpec } from "../../lib/api";
import Select from "../Select";
import Spinner from "../Spinner";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs";
import ModeSwitch from "./ModeSwitch";

// The two ways a Spec Bench binds to its delivery (SB-FR-001, SB-FR-002), one
// tab each.
const MODES: Array<{ id: SpecBenchBindMode; label: string }> = [
  { id: "launch", label: "Launch a delivery" },
  { id: "attach", label: "Attach to a record" },
];

// The dialog opens on the Launch tab.
const DEFAULT_MODE: SpecBenchBindMode = "launch";

// The spec folder a Spec Bench binds to: the folder of the discovered spec's
// test-cases.json.
function specFolderOf(spec: DiscoveredSpec): string {
  return spec.path.replace(/[\\/]test-cases\.json$/, "");
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

// The Set up Spec Bench dialog (SB-FR-001, SB-US-001), as two tabs (#1625).
// Launch a delivery: the Specification menu, the chosen spec's folder and the
// units and gates of its summary, who decides in the delivery (SB-FR-031:
// attended by default), and a line saying the bench's workspace and ports are
// assigned at create. Attach to a record: the same menu, the record's place in
// the spec folder (the bench joins the copy of it committed where its worktree
// will start, not the checkout's file), and what the summary found there: the
// progress and lifecycle state of that committed record, or that there is none. Confirm calls onConfirm with the spec
// folder, the tab's mode and the decision mode, and the host owns the create
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
  onConfirm: (
    focusedSpecPath: string,
    mode: SpecBenchBindMode,
    decisionMode: SpecBenchDecisionMode,
  ) => void;
  isCreating?: boolean;
  error?: string | null;
}) {
  const specsQuery = useTestbenchSpecs(projectId, isOpen);
  const specs = (specsQuery.data?.specs ?? []).filter((spec) => !spec.lifecycle.archived);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<SpecBenchBindMode>(DEFAULT_MODE);
  const [decisionMode, setDecisionMode] = useState<SpecBenchDecisionMode>(
    DEFAULT_SPEC_BENCH_DECISION_MODE,
  );
  const selected = specs.find((spec) => spec.path === selectedPath) ?? null;
  const summary = useSpecBenchSpecSummary(projectId, isOpen && selected ? selected.slug : null);

  const handleClose = () => {
    setSelectedPath(null);
    setMode(DEFAULT_MODE);
    setDecisionMode(DEFAULT_SPEC_BENCH_DECISION_MODE);
    onClose();
  };

  // The Specification menu, on both tabs: each spec with its case count, then
  // the chosen spec's folder (on Launch; Attach names the record path in it)
  // and the units and gates its summary read names.
  const specField = (showFolder: boolean) => (
    <div className="space-y-1.5">
      <p aria-hidden="true" className="text-13 font-medium text-text-primary">
        Specification
      </p>
      {specsQuery.isLoading && (
        <div className="flex items-center gap-2 text-13 text-text-secondary py-2">
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
          No specs found in this project&apos;s <code className="font-mono">.specifications</code>{" "}
          folder.
        </p>
      )}
      {specs.length > 0 && (
        <Select
          ariaLabel="Specification"
          placeholder="Choose a specification"
          value={selectedPath ?? ""}
          onChange={(next) => setSelectedPath(next === "" ? null : next)}
          items={specs.map((spec) => {
            const cases = `· ${plural(spec.caseCount, "case")}`;
            return {
              value: spec.path,
              label: `${spec.slug} ${cases}`,
              // A long slug truncates, and the case count stays in view.
              renderLabel: (
                <span className="flex min-w-0 gap-1">
                  <span className="min-w-0 truncate">{spec.slug}</span>{" "}
                  <span className="shrink-0">{cases}</span>
                </span>
              ),
            };
          })}
        />
      )}
      {selected && (
        <p className="space-y-0.5 text-12 text-text-secondary">
          {showFolder && (
            <span className="block break-all font-mono">{specFolderOf(selected)}</span>
          )}
          <span data-testid="specbench-setup-summary" className="block">
            {summary.isLoading && "Reading the plan..."}
            {summary.isError && <span className="text-danger-text">{summary.error.message}</span>}
            {summary.data &&
              `${plural(summary.data.units, "unit")} · ${plural(summary.data.gates, "gate")}`}
          </span>
        </p>
      )}
    </div>
  );

  const canConfirm = selected !== null && summary.isSuccess && !isCreating;

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

          <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <Tabs
              selectedKey={mode}
              onSelectionChange={(key) => {
                if (key === "launch" || key === "attach") setMode(key);
              }}
            >
              <TabList aria-label="Mode">
                {MODES.map((m) => (
                  <Tab key={m.id} id={m.id}>
                    {m.label}
                  </Tab>
                ))}
              </TabList>
              <TabPanel id="launch" className="space-y-4 pt-4">
                {specField(true)}
                <ModeSwitch value={decisionMode} onChange={setDecisionMode} />
                <p
                  data-testid="specbench-setup-workspace"
                  className="flex flex-wrap gap-x-2 text-12 text-text-secondary"
                >
                  <span className="text-text-body">Workspace and ports</span>{" "}
                  <span>assigned when the bench is created, like any bench</span>
                </p>
              </TabPanel>
              <TabPanel id="attach" className="space-y-4 pt-4">
                {specField(false)}
                {selected && (
                  <div className="space-y-1.5 text-12">
                    <p className="space-y-0.5">
                      <span className="block text-text-body">Record in the spec folder</span>
                      <span
                        data-testid="specbench-setup-record"
                        className="block break-all font-mono text-text-primary"
                      >
                        {`${specFolderOf(selected)}/${DELIVERY_RECORD_FILE}`}
                      </span>
                    </p>
                    {summary.data && (
                      <p
                        data-testid="specbench-setup-summary-delivery"
                        className="flex flex-wrap gap-x-2"
                      >
                        <span className="text-text-body">Found</span>{" "}
                        {summary.data.delivery ? (
                          <span className="min-w-0 break-all font-mono text-text-primary">
                            delivery {summary.data.delivery.deliveryId}
                            {" · "}
                            <span data-testid="specbench-setup-summary-progress">
                              {summary.data.delivery.unitsDone} of{" "}
                              {plural(summary.data.delivery.units, "unit")} done
                            </span>
                            {" · "}
                            <span data-testid="specbench-setup-summary-lifecycle">
                              {summary.data.delivery.lifecycleState}
                            </span>
                          </span>
                        ) : (
                          <span className="text-text-secondary">
                            no committed delivery record for the bench to join
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                )}
                {/* An attached delivery already runs in its own decision mode,
                    so only a launch offers the choice. An attach launches
                    nothing, and the dialog says so (SB-FR-003). */}
                <p
                  data-testid="specbench-setup-attach-note"
                  className="text-12 text-text-secondary"
                >
                  No session will be launched. The bench reads the delivery from its record, and
                  Resume launches a session when you want one.
                </p>
              </TabPanel>
            </Tabs>

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
                if (selected) onConfirm(specFolderOf(selected), mode, decisionMode);
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
