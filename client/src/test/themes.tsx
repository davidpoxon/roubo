// Theme harness for the primitive a11y suites (#1296). Each primitive is
// rendered once in the light theme and once in the dark theme. The app puts
// `.dark` on <html>, which is also where overlays portal to, so the harness
// sets it there and also wraps the render in a `.dark` element for anything
// scoped to its own subtree.
import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";

export type Theme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "dark"];

/** Render `ui` in the given theme. Call `resetTheme` in `afterEach`. */
export function renderInTheme(ui: ReactElement, theme: Theme): RenderResult {
  document.documentElement.classList.toggle("dark", theme === "dark");
  return render(<div className={theme === "dark" ? "dark" : undefined}>{ui}</div>);
}

export function resetTheme(): void {
  document.documentElement.classList.remove("dark");
}
