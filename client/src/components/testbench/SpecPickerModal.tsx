import { useState } from "react";
import {
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Button,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Label,
  Input,
} from "react-aria-components";
import { FlaskConical, FileText, AlertTriangle, Check, Loader2 } from "lucide-react";
import { useTestbenchSpecs, useManualPathValidation } from "../../hooks/useTestbenchSpecs";
import Spinner from "../Spinner";

// A selection is either a discovered spec row or the validated manual path. Both
// resolve to a focusedSpecPath (the absolute path to the spec's test-cases.json)
// that the create call binds the TestBench to.
type Selection =
  | { kind: "discovered"; slug: string; path: string }
  | { kind: "manual"; slug: string; path: string }
  | null;

// Create-a-TestBench spec picker (#418, FR-001/FR-002/FR-003). Lists the discovered
// specs and offers a manual-path escape hatch with live validation. Create stays
// disabled until a valid selection exists; on confirm it calls onCreate with the
// chosen focusedSpecPath and the host owns the create + navigate flow.
export default function SpecPickerModal({
  isOpen,
  onClose,
  projectId,
  onCreate,
  isCreating = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreate: (focusedSpecPath: string) => void;
  isCreating?: boolean;
}) {
  const { data: specs, isLoading, isError, error } = useTestbenchSpecs(projectId, isOpen);
  const [manualPath, setManualPath] = useState("");
  const [selectedDiscoveredPath, setSelectedDiscoveredPath] = useState<string | null>(null);

  const manualState = useManualPathValidation(projectId, manualPath, isOpen);

  // The active selection: a manual path takes precedence once it validates, so a
  // user who starts typing in the escape hatch overrides any earlier row click.
  let selection: Selection = null;
  if (manualPath.trim().length > 0) {
    selection =
      manualState.status === "valid"
        ? { kind: "manual", slug: manualState.slug, path: manualState.path }
        : null;
  } else if (selectedDiscoveredPath) {
    const row = specs?.find((s) => s.path === selectedDiscoveredPath);
    selection = row ? { kind: "discovered", slug: row.slug, path: row.path } : null;
  }

  const canCreate = selection !== null && !isCreating;

  const reset = () => {
    setManualPath("");
    setSelectedDiscoveredPath(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleCreate = () => {
    if (!selection) return;
    onCreate(selection.path);
  };

  const showEmptyDiscovery = !isLoading && !isError && (specs?.length ?? 0) === 0;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-lg mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  <FlaskConical size={15} className="text-amber-500" />
                  Create a TestBench
                </Heading>
                <p className="mt-1 text-xs text-stone-400 dark:text-stone-500">
                  Choose a discovered spec or point at a test-cases.json by hand. The TestBench
                  binds to the focused spec.
                </p>
              </div>

              <div className="px-5 py-4 space-y-5 max-h-[60vh] overflow-y-auto">
                {/* Discovered specs */}
                <div className="space-y-2">
                  <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                    Discovered specs
                  </p>

                  {isLoading && (
                    <div className="flex items-center gap-2 text-sm text-stone-400 dark:text-stone-600 py-3">
                      <Spinner />
                      Discovering specs...
                    </div>
                  )}

                  {isError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-300/60 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2">
                      <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {error instanceof Error ? error.message : "Failed to discover specs"}
                      </p>
                    </div>
                  )}

                  {showEmptyDiscovery && (
                    <div className="rounded-lg border border-dashed border-stone-200 dark:border-stone-800/60 px-4 py-5 text-center">
                      <p className="text-sm text-stone-500 dark:text-stone-400">
                        No specs found in this project.
                      </p>
                      <p className="mt-1 text-xs text-stone-400 dark:text-stone-600">
                        Add a{" "}
                        <code className="font-mono">
                          .specifications/&lt;slug&gt;/test-cases.json
                        </code>{" "}
                        or enter a path below.
                      </p>
                    </div>
                  )}

                  {!isLoading && !isError && (specs?.length ?? 0) > 0 && (
                    <ToggleButtonGroup
                      aria-label="Discovered specs"
                      selectionMode="single"
                      selectedKeys={
                        manualPath.trim().length === 0 && selectedDiscoveredPath
                          ? [selectedDiscoveredPath]
                          : []
                      }
                      onSelectionChange={(keys) => {
                        const next = [...keys][0];
                        setManualPath("");
                        setSelectedDiscoveredPath(typeof next === "string" ? next : null);
                      }}
                      className="flex flex-col gap-1.5"
                    >
                      {specs?.map((spec) => {
                        const isSelected =
                          manualPath.trim().length === 0 && selectedDiscoveredPath === spec.path;
                        return (
                          <ToggleButton
                            key={spec.path}
                            id={spec.path}
                            className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                              isSelected
                                ? "border-amber-500 bg-amber-50 dark:bg-amber-950/20"
                                : "border-stone-200 dark:border-stone-800/60 hover:border-stone-300 dark:hover:border-stone-700/60 hover:bg-stone-50 dark:hover:bg-stone-800/40"
                            }`}
                          >
                            <FileText
                              size={15}
                              className="text-stone-400 dark:text-stone-500 shrink-0 mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-stone-800 dark:text-stone-200">
                                {spec.slug}
                              </p>
                              <p className="text-[11px] font-mono text-stone-400 dark:text-stone-500 truncate">
                                {spec.path}
                              </p>
                            </div>
                            <span className="shrink-0 text-[11px] font-medium text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 rounded-full px-2 py-0.5">
                              {spec.caseCount} {spec.caseCount === 1 ? "case" : "cases"}
                            </span>
                            {isSelected && (
                              <Check size={14} className="text-amber-500 shrink-0 mt-0.5" />
                            )}
                          </ToggleButton>
                        );
                      })}
                    </ToggleButtonGroup>
                  )}
                </div>

                {/* Manual path escape hatch */}
                <TextField
                  value={manualPath}
                  onChange={setManualPath}
                  aria-describedby="manual-path-status"
                >
                  <Label className="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1.5">
                    Or enter a path
                  </Label>
                  <Input
                    placeholder=".specifications/<slug>/test-cases.json"
                    className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm font-mono text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <div
                    id="manual-path-status"
                    className="mt-1.5 min-h-[1.25rem] text-xs"
                    aria-live="polite"
                  >
                    {manualState.status === "validating" && (
                      <span className="flex items-center gap-1.5 text-stone-400 dark:text-stone-500">
                        <Loader2 size={12} className="animate-spin" />
                        Validating...
                      </span>
                    )}
                    {manualState.status === "valid" && (
                      <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                        <Check size={12} />
                        Valid: {manualState.slug} ({manualState.caseCount}{" "}
                        {manualState.caseCount === 1 ? "case" : "cases"})
                      </span>
                    )}
                    {manualState.status === "invalid" && (
                      <span className="flex items-start gap-1.5 text-red-600 dark:text-red-400">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                        <span>{manualState.errors.join("; ")}</span>
                      </span>
                    )}
                  </div>
                </TextField>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={() => {
                    reset();
                    close();
                  }}
                  className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
                >
                  Cancel
                </Button>
                <Button
                  onPress={handleCreate}
                  isDisabled={!canCreate}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors outline-none"
                >
                  {isCreating ? "Creating..." : "Create TestBench"}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
