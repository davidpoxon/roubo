import { useState } from "react";
import {
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  Button,
  TextField,
  Label,
  Input,
} from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { useProjects } from "../hooks/useProjects";
import { useCreateBench } from "../hooks/useBenches";
import { useGlobalCap } from "../hooks/useGlobalCap";
import Select from "./Select";

export default function CreateBenchModal({
  isOpen,
  onClose,
  projectId: fixedProjectId,
}: {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
}) {
  const { data: projects } = useProjects();
  const createBench = useCreateBench();
  const cap = useGlobalCap();
  const atCap = cap.isAtCap || cap.isOverCap;
  const [selectedProject, setSelectedProject] = useState(fixedProjectId ?? "");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");

  const validProjects = (projects ?? []).filter(
    (a): a is typeof a & { config: NonNullable<typeof a.config> } => a.configValid && !!a.config,
  );

  const handleCreate = (close: () => void) => {
    const targetProject = fixedProjectId ?? selectedProject;
    if (!targetProject) {
      setError("Select a project");
      return;
    }
    setError("");
    createBench.mutate(
      { projectId: targetProject, branch: branch.trim() || undefined },
      {
        onSuccess: () => close(),
        onError: (err) => setError((err as Error).message),
      },
    );
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <Modal className="animate-rise-in w-full max-w-md mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-16 font-semibold text-stone-900 dark:text-stone-100"
                >
                  Set up bench
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-4">
                {!fixedProjectId && (
                  <div>
                    <label className="block text-12 text-text-secondary mb-1.5">Project</label>
                    <Select
                      items={validProjects.map((p) => ({
                        value: p.id,
                        label: p.config.project.displayName,
                      }))}
                      value={selectedProject}
                      onChange={setSelectedProject}
                      placeholder="Select a project"
                    />
                  </div>
                )}

                <TextField value={branch} onChange={setBranch}>
                  <Label className="block text-12 text-text-secondary mb-1.5">Branch name</Label>
                  <Input
                    autoFocus={!!fixedProjectId}
                    placeholder="Leave empty for auto-generated"
                    onKeyDown={(e) => {
                      if (e.key === " ") {
                        e.preventDefault();
                        const input = e.currentTarget;
                        const start = input.selectionStart ?? input.value.length;
                        const end = input.selectionEnd ?? start;
                        const newValue = input.value.slice(0, start) + "-" + input.value.slice(end);
                        setBranch(newValue);
                        requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
                      }
                      if (e.key === "Enter") handleCreate(close);
                    }}
                    className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
                  />
                </TextField>

                {error && <p className="text-13 text-red-400">{error}</p>}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={close}
                  className="px-3 py-1.5 text-13 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </Button>
                <Button
                  onPress={() => handleCreate(close)}
                  isDisabled={createBench.isPending || atCap}
                  className="px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 rounded-control transition-colors outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {createBench.isPending ? "Setting up..." : "Set up"}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
