// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bug, KeyRound, Tag } from "lucide-react";
import IssueChip from "./IssueChip";

describe("IssueChip", () => {
  it("renders status variant as a pill with emerald family for open tone", () => {
    const { container } = render(
      <IssueChip variant="status" tone="open">
        Open
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain("rounded-full");
    expect(chip.className).toMatch(/emerald-/);
    expect(chip.textContent).toBe("Open");
  });

  it("uses red family for blocked tone and renders the provided icon", () => {
    const { container } = render(
      <IssueChip variant="status" tone="blocked" icon={Tag}>
        Blocked
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
    expect(chip.className).toMatch(/red-/);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("uses amber family for in-progress and stone family for done", () => {
    const { container: inProg } = render(
      <IssueChip variant="status" tone="in-progress">
        Doing
      </IssueChip>,
    );
    expect(
      (inProg.querySelector('[data-chip-category="status"]') as HTMLElement).className,
    ).toMatch(/amber-/);

    const { container: done } = render(
      <IssueChip variant="status" tone="done">
        Done
      </IssueChip>,
    );
    expect((done.querySelector('[data-chip-category="status"]') as HTMLElement).className).toMatch(
      /stone-/,
    );
  });

  it("renders label variant as rounded-sm with cyan border, no icon", () => {
    const { container } = render(
      <IssueChip variant="label" icon={Tag}>
        bug
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="label"]') as HTMLElement;
    expect(chip.className).toContain("rounded-sm");
    expect(chip.className).toMatch(/border-cyan/);
    expect(chip.className).toMatch(/cyan-/);
    expect(chip.querySelector("svg")).toBeNull();
  });

  it("renders issue-type variant as violet pill with required icon", () => {
    const { container } = render(
      <IssueChip variant="issue-type" icon={Bug}>
        Bug
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="issue-type"]') as HTMLElement;
    expect(chip.className).toContain("rounded-full");
    expect(chip.className).toMatch(/violet-/);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("renders metadata variant as stone pill with optional icon", () => {
    const { container } = render(
      <IssueChip variant="metadata" icon={KeyRound}>
        Critical
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="metadata"]') as HTMLElement;
    expect(chip.className).toContain("rounded-full");
    expect(chip.className).toMatch(/stone-/);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("renders metadata variant without an icon (e.g. +N more overflow)", () => {
    const { container } = render(<IssueChip variant="metadata">+3 more</IssueChip>);
    const chip = container.querySelector('[data-chip-category="metadata"]') as HTMLElement;
    expect(chip.querySelector("svg")).toBeNull();
    expect(chip.textContent).toBe("+3 more");
  });

  it("attaches an aria-described description for the blocked chip's blocker list", () => {
    const { container, getByText } = render(
      <IssueChip variant="status" tone="blocked" ariaDescription="Blocked by org/repo#10">
        Blocked
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
    const describedBy = chip.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const desc = getByText("Blocked by org/repo#10");
    expect(desc.id).toBe(describedBy);
    expect(desc.className).toContain("sr-only");
  });

  describe("interactive mode (WU-031)", () => {
    it("renders as a non-interactive span when onPress is omitted", () => {
      const { container } = render(
        <IssueChip variant="status" tone="warning">
          Unavailable
        </IssueChip>,
      );
      const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
      expect(chip.tagName).toBe("SPAN");
      expect(chip.getAttribute("role")).toBeNull();
    });

    it("renders as an accessible button when onPress is provided", () => {
      const onPress = vi.fn();
      render(
        <IssueChip variant="status" tone="warning" onPress={onPress}>
          Unavailable
        </IssueChip>,
      );
      const chip = screen.getByRole("button", { name: /unavailable/i });
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.className).toMatch(/amber-/);
      expect(chip.className).toContain("rounded-full");
    });

    it("invokes onPress when the button chip is clicked", async () => {
      const onPress = vi.fn();
      const user = userEvent.setup();
      render(
        <IssueChip variant="status" tone="warning" onPress={onPress}>
          Unavailable
        </IssueChip>,
      );
      await user.click(screen.getByRole("button", { name: /unavailable/i }));
      expect(onPress).toHaveBeenCalledTimes(1);
    });

    it("renders actionSuffix content inside the chip after children", () => {
      render(
        <IssueChip
          variant="status"
          tone="warning"
          onPress={vi.fn()}
          actionSuffix={<span data-testid="retry-link">Retry</span>}
        >
          Unavailable
        </IssueChip>,
      );
      const chip = screen.getByRole("button");
      expect(chip).toContainElement(screen.getByTestId("retry-link"));
      expect(chip.textContent).toContain("Unavailable");
      expect(chip.textContent).toContain("Retry");
    });

    it("preserves ariaDescription wiring in interactive mode", () => {
      render(
        <IssueChip
          variant="status"
          tone="warning"
          ariaDescription="Token lacks security_events scope"
          onPress={vi.fn()}
        >
          Unavailable
        </IssueChip>,
      );
      const chip = screen.getByRole("button");
      const describedBy = chip.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      const desc = screen.getByText("Token lacks security_events scope");
      expect(desc.id).toBe(describedBy);
      expect(desc.className).toContain("sr-only");
    });
  });
});
