import { focusRing } from "../ui/focus-ring";

// The card classes the decision pile and the review pile share: the Decision
// item and the Review card of DESIGN.md (#1622).

// The frame of a pile card, live under the 2px accent rule.
export const PILE_TOP_CARD =
  "animate-rise-in space-y-2 rounded-card border border-border border-l-2 border-l-accent bg-bg-surface p-3";

// The title bar of a lower pile card, tucked under the card above it. A focused
// bar rises over its neighbours, so its ring shows whole.
export const PILE_LOWER_BAR = `relative flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-border bg-bg-surface px-3 py-1.5 text-left transition-colors data-[hovered]:bg-bg-hover data-[pressed]:bg-bg-pressed focus-visible:z-10 ${focusRing}`;

// A lower card sits 2px under the card above it, inset on both sides.
export const PILE_LOWER_ITEM = "animate-slide-under -mt-0.5 mx-1.5";
