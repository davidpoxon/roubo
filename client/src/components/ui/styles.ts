// Class strings and helpers behind the shared primitives (#1296). They live
// apart from the components so a call site that cannot swap in a primitive,
// such as a React Aria trigger or a plain <input>, can still take the same
// tokens, and so the component modules export components only.
import { disabledControl, focusRing, focusRingOffset } from "./focus-ring";

export type ButtonVariant = "primary" | "secondary" | "danger";

// DESIGN.md Primary, Secondary, and Danger button specs. Hover and press change
// the ground, never the opacity; `data-[hovered]` and `data-[pressed]` are set
// by React Aria only while the button is enabled, so a disabled control never
// takes a hover colour.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent data-[hovered]:bg-accent-hover data-[pressed]:bg-accent-active",
  secondary:
    "bg-bg-surface text-text-body border border-border-strong data-[hovered]:bg-bg-hover data-[pressed]:bg-bg-pressed",
  danger: "bg-danger text-on-danger data-[hovered]:bg-danger-hover data-[pressed]:bg-danger-active",
};

const BUTTON_BASE_CLASSES = `inline-flex items-center justify-center gap-1.5 rounded-control text-[13px] font-medium transition-colors ${disabledControl} ${focusRingOffset}`;

// Block padding is space.3 (6px) and the inline padding double it.
const PADDING = "px-3 py-1.5";

/**
 * The class string for a button of the given variant. Exported for the rare
 * call site that styles a React Aria trigger it cannot swap for `<Button>`.
 */
export function buttonClass(variant: ButtonVariant = "secondary", className?: string): string {
  return [BUTTON_BASE_CLASSES, PADDING, VARIANT_CLASSES[variant], className]
    .filter(Boolean)
    .join(" ");
}

// DESIGN.md Nav item. The selected destination sits on accent-muted in
// accent-text at medium weight; the rest take a bg-hover wash on hover. The
// ring sits tight to the row.
const NAV_BASE_CLASSES = `flex items-center rounded-control px-3 py-1.5 text-[13px] transition-colors ${disabledControl} ${focusRing}`;

const NAV_SELECTED_CLASSES = "bg-accent-muted text-accent-text font-medium";

const NAV_RESTING_CLASSES =
  "text-text-body data-[hovered]:bg-bg-hover data-[hovered]:text-text-primary";

/** The class string for a nav row, for triggers that cannot use `<NavItem>`. */
export function navItemClass(isSelected: boolean, className?: string): string {
  return [NAV_BASE_CLASSES, isSelected ? NAV_SELECTED_CLASSES : NAV_RESTING_CLASSES, className]
    .filter(Boolean)
    .join(" ");
}

// DESIGN.md Input field. The frame is `bg-field` inside the `border-control`
// boundary (the one line that clears 3:1). Focus moves the border to the focus
// hue and adds a tight 2px ring; `invalid` moves the border to `danger`. React
// Aria sets `data-focused`/`data-invalid` on the Input; the `focus:` and
// `aria-[invalid=true]:` forms cover a plain `<input>` styled with the same
// string.
export const INPUT_CLASS =
  "w-full rounded-control border border-border-control bg-bg-field px-4 py-2 text-[13px] text-text-primary placeholder:text-text-secondary transition-colors outline-none focus:border-focus-ring focus:ring-2 focus:ring-focus-ring data-[focused]:border-focus-ring data-[focused]:ring-2 data-[focused]:ring-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger disabled:opacity-40 disabled:cursor-default";

/** Paths and commands typed into a field are set in mono. */
export const INPUT_MONO_CLASS = "font-mono";

export const FIELD_LABEL_CLASS = "block text-[11px] font-medium text-text-secondary mb-1.5";

export const FIELD_ERROR_CLASS = "mt-1.5 text-[12px] text-danger-text";

/** The input class, optionally mono, with layout-only additions. */
export function inputClass({
  mono = false,
  className,
}: { mono?: boolean; className?: string } = {}) {
  return [INPUT_CLASS, mono ? INPUT_MONO_CLASS : "", className].filter(Boolean).join(" ");
}

// DESIGN.md Status indicator dots.
export type StatusTone = "active" | "preparing" | "error" | "idle";

export const STATUS_DOT_CLASSES: Record<StatusTone, string> = {
  active: "bg-status-active",
  preparing: "bg-status-preparing",
  error: "bg-status-error",
  idle: "bg-status-idle",
};
