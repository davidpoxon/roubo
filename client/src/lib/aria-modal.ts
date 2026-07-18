// Issue #424: React Aria Components intentionally omits `aria-modal` from the
// rendered dialog (it works around a historical VoiceOver double-announce bug),
// so a role="dialog" element carries no modality semantics even though the
// backdrop, focus trap, Escape-to-close, and focus restoration all behave
// modally. RAC's <Dialog> also strips an `aria-modal` prop via filterDOMProps,
// so it has to be stamped on the dialog element through a ref.
// ModalOverlay/Modal's ariaHideOutside still inerts the background; this makes
// the modality explicit to assistive technology too, matching the visual/focus
// modality (WCAG modal semantics).
//
// Pass it directly as the `ref` of a React Aria <Dialog>:
//   <Dialog ref={stampAriaModal}>…</Dialog>
export function stampAriaModal(el: HTMLElement | null): void {
  el?.setAttribute("aria-modal", "true");
}
