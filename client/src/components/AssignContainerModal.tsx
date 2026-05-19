import { useState } from "react";
import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
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
                  Assign Container
                </Heading>
                <p className="text-[11px] text-stone-500 mt-1">
                  Select a running database container to assign to{" "}
                  <span className="font-mono text-stone-600 dark:text-stone-400">{component}</span>
                </p>
              </div>

              <div className="px-5 py-4 max-h-64 overflow-y-auto">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8 gap-2 text-sm text-stone-500 dark:text-stone-600">
                    <Spinner />
                    Loading containers...
                  </div>
                ) : runningContainers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2 text-stone-500 dark:text-stone-600">
                    <Container size={24} className="text-stone-400 dark:text-stone-700" />
                    <span className="text-sm">No running database containers found.</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {runningContainers.map((c) => {
                      const isSelected = selectedId === c.id;
                      return (
                        <Button
                          key={c.id}
                          onPress={() => setSelectedId(isSelected ? null : c.id)}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors outline-none ${
                            isSelected
                              ? "bg-stone-200 dark:bg-stone-800 ring-1 ring-stone-400 dark:ring-stone-600"
                              : "hover:bg-stone-100 dark:hover:bg-stone-800/60"
                          }`}
                        >
                          <div className="flex items-center justify-center w-4 h-4 shrink-0">
                            {isSelected && (
                              <Check size={12} className="text-stone-700 dark:text-stone-200" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
                                {c.name}
                              </span>
                              {c.port && (
                                <span className="text-[11px] font-mono text-stone-500">
                                  :{c.port}
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-stone-500 dark:text-stone-600 font-mono truncate block">
                              {c.image}
                            </span>
                          </div>
                          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
                <Button
                  onPress={close}
                  className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors rounded-lg outline-none"
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
                  className="px-4 py-1.5 text-sm font-medium text-stone-100 bg-stone-700 not-disabled:hover:bg-stone-600 disabled:opacity-40 rounded-lg transition-colors outline-none"
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
