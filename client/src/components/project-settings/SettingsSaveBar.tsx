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
        "bg-bg-surface border-t border-border",
        "transition-opacity duration-200 ease-in-out",
        hasAnyDirty ? "opacity-100" : "opacity-0 pointer-events-none h-0 overflow-hidden",
      ].join(" ")}
    >
      <div className="px-8 py-3 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          {saveErrors.length > 0 ? (
            <p role="alert" className="text-12 text-danger-text">
              Failed to save: <span className="font-medium">{saveErrors.join(", ")}</span>
            </p>
          ) : (
            <p className="text-12 text-text-secondary">You have unsaved changes</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            onPress={onDiscard}
            isDisabled={isSaving}
            className="px-3 py-2 text-13 rounded-control text-text-secondary hover:text-text-primary transition-colors outline-none disabled:opacity-40 data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring"
          >
            Discard
          </Button>
          <Button
            onPress={onSave}
            isDisabled={!hasAnyDirty || isSaving}
            className="px-4 py-2 text-13 font-medium rounded-control bg-accent text-on-accent not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-active transition-colors outline-none disabled:opacity-40 disabled:cursor-not-allowed data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring"
          >
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
