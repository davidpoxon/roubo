import { useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { SourceSelection } from "@roubo/shared";
import { useSourceCandidates } from "../hooks/useSourceCandidates";
import { useSaveProjectSources } from "../hooks/useSaveProjectSources";
import { ApiError } from "../lib/api";
import SourcePicker from "./SourcePicker";
import Spinner from "./Spinner";

interface Props {
  projectId: string;
  pluginId: string;
  pluginLabel: string;
  initialValue: SourceSelection;
}

export default function SourcePickerDialog({
  projectId,
  pluginId,
  pluginLabel,
  initialValue,
}: Props) {
  // Hoist saveMutation so the ModalOverlay can gate dismissal on isSaving;
  // otherwise Escape / overlay-click mid-save unmounts the dialog while the
  // PUT to /integration/sources is still in flight and any setErrorMessage
  // surface is lost.
  const saveMutation = useSaveProjectSources(projectId);
  const isSaving = saveMutation.isPending;

  return (
    <ModalOverlay
      isDismissable={!isSaving}
      isKeyboardDismissDisabled={isSaving}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-2xl mx-4">
        <Dialog className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none">
          {({ close }) => (
            <SourcePickerFlow
              projectId={projectId}
              pluginId={pluginId}
              pluginLabel={pluginLabel}
              initialValue={initialValue}
              close={close}
              saveMutation={saveMutation}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SourcePickerFlow({
  projectId,
  pluginId,
  pluginLabel,
  initialValue,
  close,
  saveMutation,
}: Props & {
  close: () => void;
  saveMutation: ReturnType<typeof useSaveProjectSources>;
}) {
  const { data, isLoading, isError, error } = useSourceCandidates(projectId, pluginId);
  const [draft, setDraft] = useState<SourceSelection>(initialValue);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSaving = saveMutation.isPending;

  const handleSave = async () => {
    setErrorMessage(null);
    try {
      await saveMutation.mutateAsync(draft);
      close();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Save failed",
      );
    }
  };

  return (
    <>
      <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
        <Heading slot="title" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Configure sources
        </Heading>
        <p className="mt-0.5 text-[11px] font-mono text-stone-400 dark:text-stone-600">
          {pluginLabel}
        </p>
      </div>

      <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
            <Spinner />
            Loading source candidates…
          </div>
        )}

        {isError && (
          <p role="alert" className="text-sm text-red-400">
            Failed to load source candidates:{" "}
            {error instanceof Error ? error.message : "unknown error"}
          </p>
        )}

        {data && (
          <SourcePicker
            response={data}
            value={draft}
            onChange={setDraft}
            chipContext={{ pluginId }}
          />
        )}

        {errorMessage && (
          <p role="alert" className="text-[12px] text-red-400">
            {errorMessage}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-stone-800/60">
        <Button
          isDisabled={isSaving}
          onPress={close}
          className="px-3 py-1.5 text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 disabled:opacity-50 transition-colors rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Cancel
        </Button>
        <Button
          isDisabled={isSaving || !data}
          onPress={handleSave}
          className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
        >
          {isSaving ? "Saving…" : "Save sources"}
        </Button>
      </div>
    </>
  );
}
