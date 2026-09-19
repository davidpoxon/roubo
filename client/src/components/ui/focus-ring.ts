// Shared focus treatment (DESIGN.md "Focus is one colour everywhere").
//
// Every focusable control rings in `focus-ring` at 2px. The token is tuned per
// theme (amber-700 on light grounds, amber-500 on dark), so red controls and
// inputs ring in the same hue as everything else. Controls whose spec asks for
// a ring "at a two-pixel offset" (buttons, the bench card) use the offset form;
// tight rings (tabs, nav items, menu items, chips) use the plain one.

/** A 2px `focus-ring` ring tight to the frame, shown on keyboard focus. */
export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/** The same ring at a 2px offset over the surface ground (buttons, cards). */
export const focusRingOffset = `${focusRing} focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface`;

/** The one disabled treatment: the whole control at `opacity.disabled`. */
export const disabledControl = "disabled:opacity-40 disabled:cursor-default";
