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
import { useProjects } from "../hooks/useProjects";
import { useCreateBench } from "../hooks/useBenches";
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-md mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
                <Heading
                  slot="title"
                  className="text-sm font-semibold text-stone-900 dark:text-stone-100"
                >
                  Set up bench
                </Heading>
              </div>

              <div className="px-5 py-4 space-y-4">
                {!fixedProjectId && (
                  <div>
                    <label className="block text-xs text-stone-500 mb-1.5">Project</label>
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
                  <Label className="block text-xs text-stone-500 mb-1.5">Branch name</Label>
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
                    className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-sm text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600"
                  />
                </TextField>

                {error && <p className="text-sm text-red-400">{error}</p>}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={close}
                  className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
                >
                  Cancel
                </Button>
                <Button
                  onPress={() => handleCreate(close)}
                  isDisabled={createBench.isPending}
                  className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors outline-none"
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
