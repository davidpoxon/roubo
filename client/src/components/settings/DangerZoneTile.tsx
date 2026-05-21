import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import { AlertTriangle } from "lucide-react";
import { useProjects, useUnregisterProject } from "../../hooks/useProjects";
import { useProjectBenches } from "../../hooks/useBenches";
import { useToast } from "../../hooks/useToast";
import { INPUT } from "../setup/styles";

interface Props {
  projectId: string;
}

export default function DangerZoneTile({ projectId }: Props) {
  const { data: projects } = useProjects();
  const { data: benches } = useProjectBenches(projectId);
  const unregister = useUnregisterProject();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [typedName, setTypedName] = useState("");

  const project = projects?.find((p) => p.id === projectId);
  if (!project) return null;

  const displayName = project.config?.project.displayName ?? project.repoPath;
  const benchCount = benches?.length ?? 0;
  const needsForce = !project.configValid && benchCount > 0;
  const canConfirm = typedName === displayName && !unregister.isPending;

  const handleConfirm = () => {
    unregister.mutate(
      { projectId, force: needsForce },
      {
        onSuccess: () => {
          setIsOpen(false);
          setTypedName("");
          navigate("/", { replace: true });
          addToast(`Unregistered ${displayName}.`);
        },
        onError: (err) => {
          setIsOpen(false);
          setTypedName("");
          addToast(
            err instanceof Error && err.message.length > 0
              ? err.message
              : "Failed to unregister project.",
            { duration: 8000 },
          );
        },
      },
    );
  };

  return (
    <>
      <section
        data-testid="danger-zone-tile"
        aria-label="Unregister project"
        className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/10 p-5 flex items-center justify-between gap-4"
      >
        <div>
          <div className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
            Unregister project
          </div>
          <div className="text-[11px] text-stone-500 mt-0.5">
            Removes from Roubo. Does not touch the repository, benches, or git state.
          </div>
        </div>
        <Button
          onPress={() => setIsOpen(true)}
          className="shrink-0 px-3 py-1.5 rounded-md text-[12px] font-medium text-red-700 dark:text-red-300 border border-red-300 dark:border-red-900/60 hover:bg-red-100/60 dark:hover:bg-red-900/20 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
        >
          Unregister
        </Button>
      </section>
      <ModalOverlay
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsOpen(false);
            setTypedName("");
          }
        }}
        isDismissable={!unregister.isPending}
        isKeyboardDismissDisabled={unregister.isPending}
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
                    Unregister {displayName}?
                  </Heading>
                </div>
                <div className="px-5 py-4 space-y-4">
                  <div>
                    <p className="text-sm text-stone-700 dark:text-stone-300 mb-2">
                      This only removes the project from Roubo. The following will not be touched:
                    </p>
                    <ul className="list-disc pl-5 space-y-1 text-sm text-stone-600 dark:text-stone-400">
                      <li>
                        Repository at{" "}
                        <code className="font-mono text-xs bg-stone-100 dark:bg-stone-800 px-1 py-0.5 rounded">
                          {project.repoPath}
                        </code>
                      </li>
                      <li>Branches</li>
                      <li>Existing worktrees (benches)</li>
                      <li>Git state</li>
                    </ul>
                  </div>
                  {benchCount > 0 && !needsForce && (
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-stone-700 dark:text-stone-300">
                        {benchCount} registered bench
                        {benchCount === 1 ? "" : "es"} will stop being monitored &mdash; clear them
                        first if you want Roubo to clean them up.
                      </p>
                    </div>
                  )}
                  {needsForce && (
                    <div
                      data-testid="force-unregister-note"
                      className="flex items-start gap-3 rounded-md border border-red-300 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2"
                    >
                      <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-stone-700 dark:text-stone-300">
                        This project&apos;s configuration can&apos;t be loaded. Forcing unregister
                        will drop {benchCount} tracked bench{benchCount === 1 ? "" : "es"} from
                        Roubo&apos;s state but leave any worktree files on disk alone.
                      </p>
                    </div>
                  )}
                  <TextField value={typedName} onChange={setTypedName}>
                    <Label className="block text-xs text-stone-500 mb-1.5">
                      Type{" "}
                      <span className="font-semibold text-stone-700 dark:text-stone-300">
                        {displayName}
                      </span>{" "}
                      to confirm
                    </Label>
                    <Input className={INPUT} placeholder={displayName} autoFocus />
                  </TextField>
                </div>
                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                  <Button
                    isDisabled={unregister.isPending}
                    onPress={close}
                    className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-stone-400 cursor-pointer"
                  >
                    Cancel
                  </Button>
                  <Button
                    isDisabled={!canConfirm}
                    onPress={handleConfirm}
                    className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-red-600 not-disabled:hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
                  >
                    {unregister.isPending
                      ? "Unregistering…"
                      : needsForce
                        ? "Force unregister"
                        : "Unregister"}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
