import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { FolderOpen, Check, AlertCircle, Loader2 } from "lucide-react";
import type { RegisteredProject } from "@roubo/shared";
import { useCheckConfig, useRegisterProject } from "../hooks/useProjects";
import DirectoryPicker from "./DirectoryPicker";
import EmbeddedGuidedSetup from "./EmbeddedGuidedSetup";

interface SetupHandlers {
  save: () => void;
  isSaveDisabled: boolean;
  isSaving: boolean;
  saveError?: string;
}

export default function RegisterProjectModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [repoPath, setRepoPath] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [step, setStep] = useState<"path" | "setup">("path");
  const [setupHandlers, setSetupHandlers] = useState<SetupHandlers | null>(null);
  const registerProject = useRegisterProject();

  const trimmed = repoPath.trim();
  const { data: checkResult, isLoading: isChecking, isFetching } = useCheckConfig(repoPath);

  const handleRegister = (close: () => void) => {
    setRegisterError("");
    registerProject.mutate(trimmed, {
      onSuccess: (project) => {
        close();
        navigate(`/projects/${project.id}`);
      },
      onError: (err) => {
        setRegisterError((err as Error).message);
      },
    });
  };

  const handleSaved = (close: () => void, project: RegisteredProject) => {
    close();
    navigate(`/projects/${project.id}`);
  };

  const handleClose = () => {
    setStep("path");
    setSetupHandlers(null);
    setRegisterError("");
    onClose();
  };

  const inSetup = step === "setup";

  const preview = checkResult?.preview;
  const alreadyRegistered = checkResult?.alreadyRegistered;
  const noYaml = checkResult && !checkResult.hasConfig && !checkResult.error;
  const directoryError =
    checkResult && !checkResult.hasConfig && checkResult.error === "Directory not found";
  const invalidYaml = checkResult?.hasConfig && !checkResult.configValid && checkResult.error;
  const canRegister = !!(
    checkResult?.hasConfig &&
    checkResult.configValid &&
    !alreadyRegistered &&
    !registerProject.isPending
  );

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
      isDismissable={!inSetup}
      className={`fixed inset-0 z-50 flex justify-center bg-black/60 backdrop-blur-sm ${
        inSetup ? "items-center" : "items-start pt-24"
      }`}
    >
      <Modal
        className={`w-full mx-4 flex flex-col max-h-[85vh] ${inSetup ? "max-w-2xl" : "max-w-xl"}`}
      >
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none flex flex-col min-h-0 max-h-[inherit]"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <FolderOpen size={14} className="text-amber-500" />
                  <Heading
                    slot="title"
                    className="text-sm font-medium text-stone-900 dark:text-stone-100"
                  >
                    {inSetup ? "Set up project" : "Register project"}
                  </Heading>
                </div>
                <Button
                  onPress={close}
                  isDisabled={setupHandlers?.isSaving ?? false}
                  aria-label="Close"
                  className="p-1.5 rounded-md text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {inSetup ? (
                  <EmbeddedGuidedSetup
                    repoPath={trimmed}
                    onReady={setSetupHandlers}
                    onSaved={(project) => handleSaved(close, project)}
                  />
                ) : (
                  <div className="p-6 space-y-4">
                    <DirectoryPicker
                      value={repoPath}
                      onChange={(p) => {
                        setRepoPath(p);
                        setRegisterError("");
                      }}
                    />

                    {trimmed && (isChecking || isFetching) && !checkResult && (
                      <div className="flex items-center gap-2 text-sm text-stone-500">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Checking for configuration...</span>
                      </div>
                    )}

                    {directoryError && (
                      <div className="flex items-center gap-2 text-sm text-red-400/80">
                        <AlertCircle size={14} className="shrink-0" />
                        <span>Directory not found</span>
                      </div>
                    )}

                    {alreadyRegistered && checkResult?.project && (
                      <div className="flex items-center justify-between rounded-lg bg-stone-50 dark:bg-stone-950/50 border border-stone-200 dark:border-stone-800 px-4 py-3">
                        <div className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
                          <Check size={13} className="text-green-500 shrink-0" />
                          <span>
                            <span className="font-medium text-stone-700 dark:text-stone-300">
                              {checkResult.displayName ?? checkResult.projectName}
                            </span>{" "}
                            is already registered
                          </span>
                        </div>
                        <Button
                          onPress={() => {
                            const id = checkResult?.project?.id;
                            if (id) {
                              close();
                              navigate(`/projects/${id}`);
                            }
                          }}
                          className="text-xs text-stone-500 hover:text-amber-500 transition-colors outline-none"
                        >
                          Go to project →
                        </Button>
                      </div>
                    )}

                    {noYaml && (
                      <div className="rounded-lg bg-stone-50 dark:bg-stone-950/50 border border-stone-200 dark:border-stone-800 px-4 py-3 space-y-3">
                        <p className="text-sm text-stone-500">
                          No <span className="font-mono text-[12px]">.roubo/roubo.yaml</span> found
                          in this repo
                        </p>
                        <Button
                          onPress={() => setStep("setup")}
                          className="text-xs font-medium text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors outline-none"
                        >
                          Create configuration →
                        </Button>
                      </div>
                    )}

                    {invalidYaml && (
                      <div className="space-y-2">
                        <div className="flex items-start gap-2 text-sm text-red-400/80">
                          <AlertCircle size={14} className="mt-0.5 shrink-0" />
                          <span>{checkResult.error}</span>
                        </div>
                        {checkResult.project?.id && (
                          <Button
                            onPress={() => {
                              close();
                              navigate(`/projects/${checkResult.project?.id}/settings/setup`);
                            }}
                            className="text-xs text-stone-500 hover:text-amber-500 transition-colors outline-none"
                          >
                            Edit config →
                          </Button>
                        )}
                      </div>
                    )}

                    {preview && !alreadyRegistered && (
                      <div className="rounded-lg bg-stone-50 dark:bg-stone-950/50 border border-stone-200 dark:border-stone-800 px-4 py-3">
                        <div className="flex items-center gap-2 text-[12px] text-stone-600 dark:text-stone-300 mb-2.5">
                          <Check size={13} className="text-green-500 shrink-0" />
                          <span>
                            Found <span className="font-mono">.roubo/roubo.yaml</span>
                          </span>
                        </div>
                        <dl className="text-[11px] divide-y divide-stone-200 dark:divide-stone-800/80">
                          <div className="flex justify-between py-1.5">
                            <dt className="text-stone-400 dark:text-stone-500">Name</dt>
                            <dd className="font-mono text-stone-700 dark:text-stone-300">
                              {preview.displayName}
                            </dd>
                          </div>
                          {preview.ports.map((port) => (
                            <div key={port.name} className="flex justify-between py-1.5">
                              <dt className="text-stone-400 dark:text-stone-500">
                                Port · {port.name}
                              </dt>
                              <dd className="font-mono text-stone-700 dark:text-stone-300">
                                {port.base}
                              </dd>
                            </div>
                          ))}
                          {preview.ports.length === 0 && (
                            <div className="flex justify-between py-1.5">
                              <dt className="text-stone-400 dark:text-stone-500">Ports</dt>
                              <dd className="font-mono text-stone-700 dark:text-stone-300">·</dd>
                            </div>
                          )}
                          <div className="flex justify-between py-1.5">
                            <dt className="text-stone-400 dark:text-stone-500">Bench cap</dt>
                            <dd className="font-mono text-stone-700 dark:text-stone-300">
                              {preview.benchCap}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    )}

                    {registerError && (
                      <div className="flex items-center gap-2 text-sm text-red-400/80">
                        <AlertCircle size={14} className="shrink-0" />
                        <span>{registerError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60 shrink-0">
                {inSetup ? (
                  <>
                    <Button
                      onPress={() => setStep("path")}
                      isDisabled={setupHandlers?.isSaving ?? false}
                      className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={() => setupHandlers?.save()}
                      isDisabled={setupHandlers?.isSaveDisabled ?? true}
                      className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none"
                    >
                      {setupHandlers?.isSaving ? "Saving…" : "Save & register"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      onPress={close}
                      className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={() => handleRegister(close)}
                      isDisabled={!canRegister}
                      className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none"
                    >
                      {registerProject.isPending
                        ? "Registering..."
                        : preview
                          ? `Register ${preview.displayName}`
                          : "Register project"}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
