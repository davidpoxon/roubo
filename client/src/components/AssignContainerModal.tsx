import { useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import { Container, Check } from "lucide-react";
import { useContainers, useAssignContainer } from "../hooks/useContainers";
import Spinner from "./Spinner";

interface Props {
  projectId: string;
  benchId: number;
  component: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AssignContainerModal({
  projectId,
  benchId,
  component,
  isOpen,
  onOpenChange,
}: Props) {
  const { data: containers, isLoading } = useContainers();
  const assign = useAssignContainer();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runningContainers = containers?.filter((c) => c.status === "running") ?? [];

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
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
              <div className="px-5 py-4 border-b border-border">
                <Heading slot="title" className="text-16 font-semibold text-text-primary">
                  Assign Container
                </Heading>
                <p className="text-11 text-text-secondary mt-1">
                  Select a running database container to assign to{" "}
                  <span className="font-mono text-text-secondary">{component}</span>
                </p>
              </div>

              <div className="px-5 py-4 max-h-64 overflow-y-auto">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8 gap-2 text-13 text-text-secondary">
                    <Spinner />
                    Loading containers...
                  </div>
                ) : runningContainers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2 text-text-secondary">
                    <Container size={16} className="text-text-secondary" />
                    <span className="text-13">No running database containers found.</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {runningContainers.map((c) => {
                      const isSelected = selectedId === c.id;
                      return (
                        <Button
                          key={c.id}
                          onPress={() => setSelectedId(isSelected ? null : c.id)}
                          className={`focus-visible:ring-2 focus-visible:ring-focus-ring w-full flex items-center gap-3 px-3 py-2.5 rounded-control text-left transition-colors outline-none ${
                            isSelected
                              ? "bg-bg-pressed ring-1 ring-border-control"
                              : "hover:bg-bg-hover"
                          }`}
                        >
                          <div className="flex items-center justify-center w-4 h-4 shrink-0">
                            {isSelected && <Check size={12} className="text-accent" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-13 font-medium text-text-primary truncate">
                                {c.name}
                              </span>
                              {c.port && (
                                <span className="text-11 font-mono text-text-secondary">
                                  :{c.port}
                                </span>
                              )}
                            </div>
                            <span className="text-11 text-text-body font-mono truncate block">
                              {c.image}
                            </span>
                          </div>
                          <span className="w-2 h-2 rounded-full bg-status-active shrink-0" />
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
                <Button
                  onPress={close}
                  className="px-3 py-1.5 text-13 text-text-secondary hover:text-text-primary transition-colors rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </Button>
                <Button
                  isDisabled={!selectedId || assign.isPending}
                  onPress={async () => {
                    if (!selectedId) return;
                    await assign.mutateAsync({
                      projectId,
                      benchId,
                      containerId: selectedId,
                      component,
                    });
                    close();
                  }}
                  className="px-4 py-1.5 text-13 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active disabled:opacity-40 rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {assign.isPending ? "Assigning..." : "Assign"}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
