// @vitest-environment jsdom
//
// #706 (FR-009/FR-010, US-006; verify-gate TC-045 / TC-052 / TC-053): the
// fix-issue panel captures failure notes and files a tracker issue wired to block
// the gate. A 201 complete confirms the filed refs; a 207 link_pending surfaces an
// amber "Link step failed" warning plus a "Retry link only" action that re-files
// with `existingFixRef` set (never a duplicate create). Empty notes are rejected
// client-side with an inline message and NO tracker call. A real failure (422 /
// 409 / 400) surfaces inline (degrade loudly).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import FileFixIssuePanel from "./FileFixIssuePanel";
import { ApiError } from "../../lib/api";
import { expectNoAxeFindings } from "../../test/axe";

vi.mock("../../hooks/useGates");
import { useFileFixIssue } from "../../hooks/useGates";

const mockUseFileFixIssue = vi.mocked(useFileFixIssue);

function makeMutationMock(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    error: null,
    ...overrides,
  } as unknown as ReturnType<typeof useFileFixIssue>;
}

const RECORD = {
  fixIssueRef: "acme/app#452",
  gateRef: "acme/app#451",
  failedCaseId: "TC-024",
  createdAt: "2026-07-08T00:00:00.000Z",
};

function renderPanel(onFiled?: () => void) {
  return render(
    <FileFixIssuePanel
      projectId="p1"
      benchId={3}
      gateId="WU-040"
      failedCaseId="TC-024"
      onFiled={onFiled}
    />,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseFileFixIssue.mockReturnValue(makeMutationMock());
});

describe("FileFixIssuePanel (TC-045: file a fix issue that blocks the gate)", () => {
  it("files with the entered notes and confirms the blocked refs on a complete filing", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn(
      (_body: unknown, opts: { onSuccess?: (r: unknown) => void; onSettled?: () => void }) => {
        opts.onSuccess?.({ ...RECORD, linkStatus: "complete" });
        opts.onSettled?.();
      },
    );
    const onFiled = vi.fn();
    mockUseFileFixIssue.mockReturnValue(makeMutationMock({ mutate }));

    renderPanel(onFiled);
    await user.type(screen.getByRole("textbox", { name: /notes/i }), "Retry loops forever");
    await user.click(screen.getByRole("button", { name: /File fix issue & block gate/ }));

    expect(mutate).toHaveBeenCalledWith(
      { failedCaseId: "TC-024", notes: "Retry loops forever" },
      expect.objectContaining({ onSuccess: expect.any(Function), onSettled: expect.any(Function) }),
    );
    const confirmation = screen.getByTestId("fix-issue-confirmation");
    // Reliable refs plus the gate id (WU-041 is not carried by the record, so it
    // is not fabricated): the fix issue ref, the gate id, and the gate ref.
    expect(confirmation).toHaveTextContent("acme/app#452");
    expect(confirmation).toHaveTextContent("WU-040");
    expect(confirmation).toHaveTextContent("acme/app#451");
    expect(onFiled).toHaveBeenCalled();
    // The notes form is replaced by the confirmation once filed.
    expect(screen.queryByRole("button", { name: /File fix issue & block gate/ })).toBeNull();
  });
});

describe("FileFixIssuePanel (TC-052: link_pending partial failure + link-only retry)", () => {
  it("surfaces the link-step warning and retries with existingFixRef, then clears on success", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn(
      (
        body: { existingFixRef?: string },
        opts: { onSuccess?: (r: unknown) => void; onSettled?: () => void },
      ) => {
        // First call (no existingFixRef) leaves the link pending; the retry (with
        // existingFixRef) completes it.
        opts.onSuccess?.({
          ...RECORD,
          linkStatus: body.existingFixRef ? "complete" : "link_pending",
        });
        opts.onSettled?.();
      },
    );
    mockUseFileFixIssue.mockReturnValue(makeMutationMock({ mutate }));

    renderPanel();
    await user.type(screen.getByRole("textbox", { name: /notes/i }), "Broke on the second step");
    await user.click(screen.getByRole("button", { name: /File fix issue & block gate/ }));

    // The partial-failure warning is shown, distinct from a full success, with the
    // gate NOT passable and a link-only retry offered.
    const warning = screen.getByTestId("fix-issue-link-pending");
    expect(warning).toHaveTextContent(/Link step failed/i);
    expect(warning).toHaveTextContent(/not\s+passable/i);
    expect(screen.queryByTestId("fix-issue-confirmation")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Retry link only/ }));

    // The retry re-files only the link step against the already-created ref.
    expect(mutate).toHaveBeenLastCalledWith(
      { failedCaseId: "TC-024", notes: "Broke on the second step", existingFixRef: "acme/app#452" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    // On success the warning clears and the filed refs are confirmed.
    expect(screen.queryByTestId("fix-issue-link-pending")).toBeNull();
    expect(screen.getByTestId("fix-issue-confirmation")).toBeInTheDocument();
  });
});

describe("FileFixIssuePanel (TC-053: empty notes rejected client-side)", () => {
  it("blocks submission with an inline required message and makes no tracker call", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseFileFixIssue.mockReturnValue(makeMutationMock({ mutate }));

    renderPanel();
    await user.click(screen.getByRole("button", { name: /File fix issue & block gate/ }));

    expect(screen.getByTestId("fix-issue-notes-required")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("also rejects whitespace-only notes without a call", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseFileFixIssue.mockReturnValue(makeMutationMock({ mutate }));

    renderPanel();
    await user.type(screen.getByRole("textbox", { name: /notes/i }), "   ");
    await user.click(screen.getByRole("button", { name: /File fix issue & block gate/ }));

    expect(screen.getByTestId("fix-issue-notes-required")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("clears the required message once notes are entered", async () => {
    const user = userEvent.setup();
    mockUseFileFixIssue.mockReturnValue(makeMutationMock({ mutate: vi.fn() }));

    renderPanel();
    await user.click(screen.getByRole("button", { name: /File fix issue & block gate/ }));
    expect(screen.getByTestId("fix-issue-notes-required")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /notes/i }), "Now described");
    expect(screen.queryByTestId("fix-issue-notes-required")).toBeNull();
  });
});

describe("FileFixIssuePanel (FR-011: degrade loudly)", () => {
  it("surfaces a server failure inline and keeps the form", () => {
    mockUseFileFixIssue.mockReturnValue(
      makeMutationMock({
        error: new ApiError(
          "Gate 'WU-040' has no tracker issue, so a fix issue cannot be wired to block it.",
          409,
        ),
      }),
    );

    renderPanel();
    expect(screen.getByText(/no tracker issue/)).toBeInTheDocument();
    // The form stays so the operator can act on the failure.
    expect(screen.getByRole("button", { name: /File fix issue & block gate/ })).toBeInTheDocument();
  });

  it("disables the submit and shows a pending label while filing", () => {
    mockUseFileFixIssue.mockReturnValue(makeMutationMock({ isPending: true }));

    renderPanel();
    expect(screen.getByRole("button", { name: /Filing/ })).toBeDisabled();
  });
});

describe("FileFixIssuePanel a11y", () => {
  it("has no axe violations", async () => {
    const { container } = renderPanel();
    const results = await axe(container);
    expectNoAxeFindings(results);
  });
});
