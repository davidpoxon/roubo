import { Button } from "react-aria-components";

interface Props {
  hasAnyDirty: boolean;
  isSaving: boolean;
  saveErrors: string[];
  onSave: () => void;
  onDiscard: () => void;
}

export function SettingsSaveBar({ hasAnyDirty, isSaving, saveErrors, onSave, onDiscard }: Props) {
  return (
    <div
      data-testid="settings-save-bar"
      aria-hidden={!hasAnyDirty}
      className={[
        "shrink-0 w-full",
        "bg-white dark:bg-stone-950 border-t border-stone-200 dark:border-stone-800/40",
        "transition-opacity duration-200 ease-in-out",
        hasAnyDirty ? "opacity-100" : "opacity-0 pointer-events-none h-0 overflow-hidden",
      ].join(" ")}
    >
      <div className="px-8 py-3 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          {saveErrors.length > 0 ? (
            <p role="alert" className="text-[12px] text-red-500 dark:text-red-400">
              Failed to save: <span className="font-medium">{saveErrors.join(", ")}</span>
            </p>
          ) : (
            <p className="text-[12px] text-stone-400 dark:text-stone-500">
              You have unsaved changes
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            onPress={onDiscard}
            isDisabled={isSaving}
            className="px-3 py-2 text-[13px] rounded-lg text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors outline-none disabled:opacity-40 data-[focus-visible]:ring-2 data-[focus-visible]:ring-stone-400"
          >
            Discard
          </Button>
          <Button
            onPress={onSave}
            isDisabled={!hasAnyDirty || isSaving}
            className="px-4 py-2 text-[13px] font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors outline-none disabled:opacity-40 disabled:cursor-not-allowed data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-400"
          >
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
