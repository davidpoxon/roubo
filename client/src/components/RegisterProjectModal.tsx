import { useState } from "react";
import { useNavigate } from "react-router";
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
      className={`fixed inset-0 z-50 flex justify-center bg-scrim backdrop-blur-sm ${
        inSetup ? "items-center" : "items-start pt-24"
      }`}
    >
      <Modal
        className={`animate-rise-in w-full mx-4 flex flex-col max-h-[85vh] ${inSetup ? "max-w-2xl" : "max-w-xl"}`}
      >
        <Dialog
          ref={stampAriaModal}
          className="bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none flex flex-col min-h-0 max-h-[inherit]"
        >
          {({ close }) => (
            <>
              <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <FolderOpen size={14} className="text-accent-text" />
                  <Heading slot="title" className="text-16 font-medium text-text-primary">
                    {inSetup ? "Set up project" : "Register project"}
                  </Heading>
                </div>
                <Button
                  onPress={close}
                  isDisabled={setupHandlers?.isSaving ?? false}
                  aria-label="Close"
                  className="p-1.5 rounded-control text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors outline-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                      <div className="flex items-center gap-2 text-13 text-text-secondary">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Checking for configuration...</span>
                      </div>
                    )}

                    {directoryError && (
                      <div className="flex items-center gap-2 text-13 text-danger-text">
                        <AlertCircle size={14} className="shrink-0" />
                        <span>Directory not found</span>
                      </div>
                    )}

                    {alreadyRegistered && checkResult?.project && (
                      <div className="flex items-center justify-between rounded-lg bg-bg-base border border-border px-4 py-3">
                        <div className="flex items-center gap-2 text-13 text-text-secondary">
                          <Check size={14} className="text-success-text shrink-0" />
                          <span>
                            <span className="font-medium text-text-body">
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
                          className="text-12 text-text-secondary hover:text-accent-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          Go to project →
                        </Button>
                      </div>
                    )}

                    {noYaml && (
                      <div className="rounded-lg bg-bg-base border border-border px-4 py-3 space-y-3">
                        <p className="text-13 text-text-secondary">
                          No <span className="font-mono text-12">.roubo/roubo.yaml</span> found in
                          this repo
                        </p>
                        <Button
                          onPress={() => setStep("setup")}
                          className="text-12 font-medium text-accent-text hover:underline transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                        >
                          Create configuration →
                        </Button>
                      </div>
                    )}

                    {invalidYaml && (
                      <div className="space-y-2">
                        <div className="flex items-start gap-2 text-13 text-danger-text">
                          <AlertCircle size={14} className="mt-0.5 shrink-0" />
                          <span>{checkResult.error}</span>
                        </div>
                        {checkResult.project?.id && (
                          <Button
                            onPress={() => {
                              close();
                              navigate(`/projects/${checkResult.project?.id}/settings/setup`);
                            }}
                            className="text-12 text-text-secondary hover:text-accent-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          >
                            Edit config →
                          </Button>
                        )}
                      </div>
                    )}

                    {preview && !alreadyRegistered && (
                      <div className="rounded-lg bg-bg-base border border-border px-4 py-3">
                        <div className="flex items-center gap-2 text-12 text-text-body mb-2.5">
                          <Check size={14} className="text-success-text shrink-0" />
                          <span>
                            Found <span className="font-mono">.roubo/roubo.yaml</span>
                          </span>
                        </div>
                        <dl className="text-11 divide-y divide-border">
                          <div className="flex justify-between py-1.5">
                            <dt className="text-text-secondary">Name</dt>
                            <dd className="font-mono text-text-body">{preview.displayName}</dd>
                          </div>
                          {preview.ports.map((port) => (
                            <div key={port.name} className="flex justify-between py-1.5">
                              <dt className="text-text-secondary">Port · {port.name}</dt>
                              <dd className="font-mono text-text-body">{port.base}</dd>
                            </div>
                          ))}
                          {preview.ports.length === 0 && (
                            <div className="flex justify-between py-1.5">
                              <dt className="text-text-secondary">Ports</dt>
                              <dd className="font-mono text-text-body">·</dd>
                            </div>
                          )}
                          <div className="flex justify-between py-1.5">
                            <dt className="text-text-secondary">Bench cap</dt>
                            <dd className="font-mono text-text-body">{preview.benchCap}</dd>
                          </div>
                        </dl>
                      </div>
                    )}

                    {registerError && (
                      <div className="flex items-center gap-2 text-13 text-danger-text">
                        <AlertCircle size={14} className="shrink-0" />
                        <span>{registerError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
                {inSetup ? (
                  <>
                    <Button
                      onPress={() => setStep("path")}
                      isDisabled={setupHandlers?.isSaving ?? false}
                      className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={() => setupHandlers?.save()}
                      isDisabled={setupHandlers?.isSaveDisabled ?? true}
                      className="px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-control transition-colors outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      {setupHandlers?.isSaving ? "Saving…" : "Save & register"}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      onPress={close}
                      className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      Cancel
                    </Button>
                    <Button
                      onPress={() => handleRegister(close)}
                      isDisabled={!canRegister}
                      className="px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-control transition-colors outline-none not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
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
