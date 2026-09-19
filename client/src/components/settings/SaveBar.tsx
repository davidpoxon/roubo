import { Button } from "react-aria-components";

interface SaveBarProps {
  onSave: () => void;
  isSaving: boolean;
  isDisabled: boolean;
  saveLabel: string;
  errorSummary?: string;
}

export default function SaveBar({
  onSave,
  isSaving,
  isDisabled,
  saveLabel,
  errorSummary,
}: SaveBarProps) {
  return (
    <div
      role="toolbar"
      className="sticky bottom-0 z-10 flex items-center justify-between gap-4 px-8 py-3 bg-white dark:bg-stone-950 border-t border-stone-200 dark:border-stone-800/40"
    >
      <div className="flex-1">
        {errorSummary && <p className="text-13 text-red-500 dark:text-red-400">{errorSummary}</p>}
      </div>
      <Button
        onPress={onSave}
        isDisabled={isDisabled || isSaving}
        className="px-4 py-2 text-13 font-medium rounded-control transition-colors outline-none bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring"
      >
        {saveLabel}
      </Button>
    </div>
  );
}
