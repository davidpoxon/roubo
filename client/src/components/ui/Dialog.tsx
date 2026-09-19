import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
} from "react-aria-components";
import { stampAriaModal } from "../../lib/aria-modal";

// DESIGN.md Dialog: the surface at elevation.1 over the scrim, 12px radius,
// one decision per dialog, actions right-aligned with the consequential one
// last. The frame itself takes no ring; focus moves to the first control.
export const DIALOG_OVERLAY_CLASS = "fixed inset-0 z-50 flex items-center justify-center bg-scrim";

export const DIALOG_FRAME_CLASS =
  "bg-bg-surface border border-border rounded-card shadow-elevation-1 outline-none";

export const DIALOG_TITLE_CLASS = "text-[16px] font-semibold text-text-primary";

export const DIALOG_ACTIONS_CLASS = "flex items-center justify-end gap-2";

export interface DialogProps extends Omit<ModalOverlayProps, "className" | "children"> {
  /** The dialog title, rendered as the accessible heading. */
  title: ReactNode;
  children: ReactNode | ((opts: { close: () => void }) => ReactNode);
  /** Width class for the modal, such as `max-w-sm`. */
  widthClassName?: string;
  /** Layout-only additions for the frame (padding, gap). */
  className?: string;
  role?: "dialog" | "alertdialog";
}

/**
 * The shared modal dialog. Children render below the title; use
 * `DIALOG_ACTIONS_CLASS` for the action row.
 */
export default function Dialog({
  title,
  children,
  widthClassName = "max-w-md",
  className,
  role,
  ...overlayProps
}: DialogProps) {
  return (
    <ModalOverlay {...overlayProps} className={DIALOG_OVERLAY_CLASS}>
      <Modal className={`animate-rise-in w-full mx-4 ${widthClassName}`}>
        <AriaDialog
          ref={stampAriaModal}
          role={role}
          className={[DIALOG_FRAME_CLASS, "flex flex-col gap-3 p-5", className]
            .filter(Boolean)
            .join(" ")}
        >
          {({ close }) => (
            <>
              <Heading slot="title" className={DIALOG_TITLE_CLASS}>
                {title}
              </Heading>
              {typeof children === "function" ? children({ close }) : children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
