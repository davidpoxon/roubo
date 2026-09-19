// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bug, KeyRound, Package, Shield, Tag } from "lucide-react";
import IssueChip from "./IssueChip";

describe("IssueChip", () => {
  it("renders status variant as a 4px chip in the issue-open tone", () => {
    const { container } = render(
      <IssueChip variant="status" tone="open">
        Open
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain("rounded-chip");
    expect(chip.className).toContain("bg-issue-open");
    expect(chip.className).toContain("text-issue-open-text");
    expect(chip.textContent).toBe("Open");
  });

  it("uses the danger pair for blocked tone and renders the provided icon", () => {
    const { container } = render(
      <IssueChip variant="status" tone="blocked" icon={Tag}>
        Blocked
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="status"]') as HTMLElement;
    expect(chip.className).toContain("bg-danger-surface");
    expect(chip.className).toContain("text-danger-text");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("uses the accent pair for in-progress and a quiet ground for done", () => {
    const { container: inProg } = render(
      <IssueChip variant="status" tone="in-progress">
        Doing
      </IssueChip>,
    );
    expect(
      (inProg.querySelector('[data-chip-category="status"]') as HTMLElement).className,
    ).toContain("text-accent-text");

    const { container: done } = render(
      <IssueChip variant="status" tone="done">
        Done
      </IssueChip>,
    );
    expect(
      (done.querySelector('[data-chip-category="status"]') as HTMLElement).className,
    ).toContain("text-text-secondary");
  });

  it("renders label variant as an outlined chip in the issue-label tone, no icon", () => {
    const { container } = render(
      <IssueChip variant="label" icon={Tag}>
        bug
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="label"]') as HTMLElement;
    expect(chip.className).toContain("rounded-chip");
    expect(chip.className).toContain("border-issue-label-border");
    expect(chip.className).toContain("text-issue-label-text");
    expect(chip.querySelector("svg")).toBeNull();
  });

  it("renders issue-type variant in the issue-type tone with required icon", () => {
    const { container } = render(
      <IssueChip variant="issue-type" icon={Bug}>
        Bug
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="issue-type"]') as HTMLElement;
    expect(chip.className).toContain("rounded-chip");
    expect(chip.className).toContain("bg-issue-type");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("renders metadata variant as a neutral chip with optional icon", () => {
    const { container } = render(
      <IssueChip variant="metadata" icon={KeyRound}>
        Critical
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="metadata"]') as HTMLElement;
    expect(chip.className).toContain("rounded-chip");
    expect(chip.className).toContain("bg-bg-pressed");
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

  it("bounds a long-label chip to its container and truncates the text span", () => {
    const longLabel = "Adaptive flow scoping: Phase 2 (per-stage mode/depth contract)";
    const { container } = render(
      <IssueChip variant="milestone" tooltip={longLabel}>
        {longLabel}
      </IssueChip>,
    );
    const chip = container.querySelector('[data-chip-category="milestone"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain("max-w-full");
    expect(chip.className).toContain("min-w-0");
    const textSpan = chip.querySelector("span.truncate") as HTMLElement;
    expect(textSpan).not.toBeNull();
    expect(textSpan.className).toContain("truncate");
    expect(textSpan.className).toContain("min-w-0");
    expect(textSpan.textContent).toBe(longLabel);
  });

  describe("interactive mode (IP-WU-031)", () => {
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
      expect(chip.className).toContain("bg-accent-muted");
      expect(chip.className).toContain("rounded-chip");
      // Hover draws a hairline in the tone's own text hue, never dims.
      expect(chip.className).toContain("data-[hovered]:border-accent-text");
      expect(chip.className).not.toMatch(/brightness|hover:opacity/);
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

  describe("security-category variant (IP-WU-033)", () => {
    it("uses the neutral tone for codeql", () => {
      const { container } = render(
        <IssueChip variant="security-category" securityCategory="codeql" icon={Shield}>
          CodeQL
        </IssueChip>,
      );
      const chip = container.querySelector(
        '[data-chip-category="security-category"]',
      ) as HTMLElement;
      expect(chip).not.toBeNull();
      expect(chip.className).toContain("rounded-chip");
      expect(chip.className).toContain("bg-bg-pressed");
      expect(chip.querySelector("svg")).not.toBeNull();
    });

    it("uses the accent tone for secret-scanning", () => {
      const { container } = render(
        <IssueChip variant="security-category" securityCategory="secret-scanning" icon={KeyRound}>
          Secret scanning
        </IssueChip>,
      );
      const chip = container.querySelector(
        '[data-chip-category="security-category"]',
      ) as HTMLElement;
      expect(chip.className).toContain("text-accent-text");
    });

    it("uses the neutral tone for dependabot", () => {
      const { container } = render(
        <IssueChip variant="security-category" securityCategory="dependabot" icon={Package}>
          Dependabot
        </IssueChip>,
      );
      const chip = container.querySelector(
        '[data-chip-category="security-category"]',
      ) as HTMLElement;
      expect(chip.className).toContain("bg-bg-pressed");
    });

    it("wraps in a focusable Button when tooltip is provided", () => {
      const { container } = render(
        <IssueChip
          variant="security-category"
          securityCategory="codeql"
          icon={Shield}
          tooltip="org/repo#code-scanning-7"
        >
          CodeQL
        </IssueChip>,
      );
      const chip = container.querySelector(
        '[data-chip-category="security-category"]',
      ) as HTMLElement;
      expect(chip.tagName).toBe("BUTTON");
    });
  });

  describe("tooltip mode (IP-WU-042)", () => {
    it("renders a keyboard-focusable Button when a tooltip is provided", () => {
      const { container } = render(
        <IssueChip variant="issue-type" icon={Bug} tooltip="Severity: High">
          CodeQL
        </IssueChip>,
      );
      const chip = container.querySelector('[data-chip-category="issue-type"]') as HTMLElement;
      expect(chip).not.toBeNull();
      expect(chip.tagName).toBe("BUTTON");
      expect(chip.className).toContain("focus-visible:ring-focus-ring");
      expect(chip.textContent).toContain("CodeQL");
    });

    it("renders a plain span when no tooltip is provided", () => {
      const { container } = render(
        <IssueChip variant="issue-type" icon={Bug}>
          Bug
        </IssueChip>,
      );
      const chip = container.querySelector('[data-chip-category="issue-type"]') as HTMLElement;
      expect(chip.tagName).toBe("SPAN");
    });
  });
});
