// @vitest-environment jsdom
//
// #774 (SATCA-TC-073..077 accessibility pass, SATCA-FR-028/FR-029): the
// replacement picker is fully keyboard operable (arrow keys move the active
// case, Enter confirms, Escape dismisses) and the open dialog has zero axe
// violations. Focus restoration to the opening control is covered where the
// opening control lives, in CaseDetail.a11y.test.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import ReplacementPicker from "./ReplacementPicker";
import { expectNoAxeFindings } from "../../test/axe";
import type { ReplacementCandidatesResponse } from "../../lib/api";

vi.mock("../../hooks/useReplacementCandidates", () => ({
  useReplacementCandidates: vi.fn(),
}));
import { useReplacementCandidates } from "../../hooks/useReplacementCandidates";

const mockCandidates = vi.mocked(useReplacementCandidates);

const PAYLOAD: ReplacementCandidatesResponse = {
  originSlug: "testbench",
  slug: "testbench",
  specs: [
    { slug: "testbench", caseCount: 3, archived: false },
    { slug: "verify-gate", caseCount: 1, archived: false },
  ],
  plans: {
    testbench: {
      specSlug: "testbench",
      cases: [
        { id: "TC-001", title: "The case being superseded", area: "reconcile", level: 1 },
        { id: "TC-002", title: "Live sibling case", area: "reconcile", level: 2 },
        { id: "TC-003", title: "Another live case", area: "staleness", level: 2 },
      ],
    },
  },
  specLifecycles: {},
};

function mountPicker(onConfirm = vi.fn(), onClose = vi.fn()) {
  const rendered = render(
    <ReplacementPicker
      isOpen
      onClose={onClose}
      projectId="p1"
      benchId={4}
      originCaseId="TC-001"
      originCaseArea="reconcile"
      onConfirm={onConfirm}
    />,
  );
  return { ...rendered, onConfirm, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCandidates.mockReturnValue({
    data: PAYLOAD,
    isLoading: false,
    isError: false,
    error: null,
  } as never);
});

describe("ReplacementPicker keyboard operation", () => {
  it("moves the active case with the arrow keys and reflects it in the preview", async () => {
    const user = userEvent.setup();
    mountPicker();
    const filter = screen.getByTestId("replacement-filter");
    await user.click(filter);

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("replacement-option-TC-002")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("replacement-preview")).toHaveTextContent(
      "Resolves directly to TC-002",
    );

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("replacement-option-TC-003")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The combobox points assistive technology at the active option rather than
    // moving DOM focus out of the filter.
    expect(filter).toHaveFocus();
    expect(filter.getAttribute("aria-activedescendant")).toBe(
      screen.getByTestId("replacement-option-TC-003").id,
    );

    await user.keyboard("{ArrowUp}");
    expect(screen.getByTestId("replacement-option-TC-002")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("confirms the active case with Enter", async () => {
    const user = userEvent.setup();
    const { onConfirm } = mountPicker();
    await user.click(screen.getByTestId("replacement-filter"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onConfirm).toHaveBeenCalledWith("TC-002");
  });

  it("does not confirm an unchosen (and therefore unresolvable) pointer with Enter", async () => {
    const user = userEvent.setup();
    const { onConfirm } = mountPicker();
    await user.click(screen.getByTestId("replacement-filter"));
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dismisses with Escape without confirming", async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose } = mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-002"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// #775 (SATCA-TC-078, AC3/AC6): the dialog declares its modality, the filter is
// labelled, and the result count is announced as the query narrows the list.
describe("ReplacementPicker dialog and filter semantics (#775)", () => {
  it("stamps aria-modal on the dialog", () => {
    mountPicker();
    // React Aria omits aria-modal and strips the prop, so the shared
    // stampAriaModal ref is what makes the modality explicit to AT (#612/#424).
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("labels the filter and names the listbox it drives", () => {
    mountPicker();
    const filter = screen.getByRole("combobox", { name: "Replacement case" });
    expect(filter).toBe(screen.getByTestId("replacement-filter"));
    expect(filter.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Replacement cases");
  });

  it("announces the result count in a polite region as the query changes", async () => {
    const user = userEvent.setup();
    mountPicker();
    const count = screen.getByTestId("replacement-count");
    expect(count).toHaveAttribute("aria-live", "polite");
    // TC-001 is the case being superseded and is excluded from its own list.
    expect(count).toHaveTextContent("2 of 2 cases");

    await user.type(screen.getByTestId("replacement-filter"), "staleness");
    expect(count).toHaveTextContent("1 of 2 cases");

    await user.clear(screen.getByTestId("replacement-filter"));
    await user.type(screen.getByTestId("replacement-filter"), "zzzz");
    expect(count).toHaveTextContent("0 of 2 cases");
  });

  it("conveys the active option to assistive technology without moving DOM focus", async () => {
    const user = userEvent.setup();
    mountPicker();
    const filter = screen.getByTestId("replacement-filter");
    await user.click(filter);
    await user.keyboard("{ArrowDown}");

    const active = screen.getByTestId("replacement-option-TC-002");
    expect(filter).toHaveAttribute("aria-activedescendant", active.id);
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(filter).toHaveFocus();
  });
});

describe("ReplacementPicker a11y", () => {
  it("has no axe violations with a selection made", async () => {
    const user = userEvent.setup();
    const { baseElement } = mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-002"));
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe violations in the empty-filter state", async () => {
    const user = userEvent.setup();
    const { baseElement } = mountPicker();
    await user.type(screen.getByTestId("replacement-filter"), "zzzz");
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });
});
