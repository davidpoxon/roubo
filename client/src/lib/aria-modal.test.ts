// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { stampAriaModal } from "./aria-modal";

describe("stampAriaModal", () => {
  it('sets aria-modal="true" on a real element', () => {
    const el = document.createElement("div");
    stampAriaModal(el);
    expect(el.getAttribute("aria-modal")).toBe("true");
  });

  it("is a null-safe no-op when the ref detaches (null)", () => {
    expect(() => stampAriaModal(null)).not.toThrow();
  });
});
