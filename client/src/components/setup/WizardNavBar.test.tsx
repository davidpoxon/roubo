// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WizardNavBar from "./WizardNavBar";
import { WIZARD_SECTIONS, SECTION_LABELS, type WizardSection } from "./wizardReducer";

function renderNavBar(
  currentSection: WizardSection,
  options?: {
    currentSubStep?: string | null;
    prevSubStep?: { section: WizardSection; subStep: string | null } | null;
    prevSubStepLabel?: string | null;
    onBack?: () => void;
    onContinue?: () => void;
  },
) {
  return render(
    <WizardNavBar
      currentSection={currentSection}
      currentSubStep={options?.currentSubStep ?? null}
      prevSubStep={options?.prevSubStep ?? null}
      prevSubStepLabel={options?.prevSubStepLabel}
      onBack={options?.onBack ?? vi.fn()}
      onContinue={options?.onContinue ?? vi.fn()}
    />,
  );
}

describe("WizardNavBar", () => {
  it("shows no back button on the first section", () => {
    renderNavBar("project");
    expect(screen.queryByText(SECTION_LABELS["project"])).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
  });

  it("shows a back button when not on the first section", () => {
    renderNavBar("layout");
    expect(screen.getByText(SECTION_LABELS["project"])).toBeInTheDocument();
  });

  it('shows "Review" label on the last section before review', () => {
    // 'benches' is the section before 'review'
    renderNavBar("benches");
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
  });

  it("shows no next button on the review section", () => {
    renderNavBar("review");
    expect(screen.queryByRole("button", { name: /continue|review/i })).not.toBeInTheDocument();
  });

  it("calls onBack when the back button is pressed", async () => {
    const onBack = vi.fn();
    renderNavBar("components", { onBack });
    const prevSection = WIZARD_SECTIONS[WIZARD_SECTIONS.indexOf("components") - 1] as WizardSection;
    await userEvent.click(screen.getByText(SECTION_LABELS[prevSection]));
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onContinue when the next button is pressed", async () => {
    const onContinue = vi.fn();
    renderNavBar("project", { onContinue });
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onContinue).toHaveBeenCalled();
  });

  it("shows back button when on a sub-step with no prevSubStep", () => {
    renderNavBar("components", { currentSubStep: "server" });
    // No prevSubStep means the back label would be the previous section
    expect(screen.getByText(SECTION_LABELS["layout"])).toBeInTheDocument();
  });

  it("shows the section label as back label when prevSubStep.subStep is null (going to overview)", () => {
    renderNavBar("components", {
      currentSubStep: "server",
      prevSubStep: { section: "components", subStep: null },
    });
    expect(screen.getByText(SECTION_LABELS["components"])).toBeInTheDocument();
  });

  it("shows the sub-step name as back label when prevSubStep.subStep is not null (navigating between sub-steps)", () => {
    renderNavBar("components", {
      currentSubStep: "database",
      prevSubStep: { section: "components", subStep: "server" },
    });
    expect(screen.getByText("server")).toBeInTheDocument();
  });

  it("prevSubStepLabel overrides the default back label", () => {
    renderNavBar("tools", {
      currentSubStep: "tool-1",
      prevSubStep: { section: "tools", subStep: "tool-0" },
      prevSubStepLabel: "My Browser",
    });
    expect(screen.getByText("My Browser")).toBeInTheDocument();
    expect(screen.queryByText("tool-0")).not.toBeInTheDocument();
  });

  it("shows Continue (not Review) label when on a sub-step of the last section", () => {
    renderNavBar("benches", { currentSubStep: "some-sub-step" });
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
  });
});
