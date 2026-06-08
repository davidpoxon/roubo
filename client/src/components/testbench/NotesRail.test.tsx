// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Note } from "@roubo/shared/testbench-contracts";
import { NotesRail } from "./NotesRail";

vi.mock("../../hooks/useTestbenchNotes");
import { useAppendNote } from "../../hooks/useTestbenchNotes";

const mockUseAppendNote = vi.mocked(useAppendNote);

function makeAppendMock(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    error: null,
    ...overrides,
  } as unknown as ReturnType<typeof useAppendNote>;
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    text: "Observed the failure on retry.",
    author: { name: "Ada Lovelace", email: "ada@example.com" },
    timestamp: "2026-06-08T10:00:00.000Z",
    statusAtWrite: "failed",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseAppendNote.mockReturnValue(makeAppendMock());
});

describe("NotesRail (TC-028: stamped, append-only)", () => {
  it("renders each note stamped with author, timestamp, and status-at-write", () => {
    const note = makeNote();
    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[note]} />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText(note.text)).toBeInTheDocument();
    const time = screen.getByText((_content, el) => el?.tagName.toLowerCase() === "time");
    expect(time).toHaveAttribute("dateTime", note.timestamp);
  });

  it("exposes no edit or delete affordance on a note", () => {
    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[makeNote()]} />);

    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    // The only button is the add-note submit.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /add note/i })).toBeInTheDocument();
  });
});

describe("NotesRail (TC-032: blank rejected)", () => {
  it("disables submit for an empty field and never calls the mutation", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseAppendNote.mockReturnValue(makeAppendMock({ mutate }));

    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[]} />);

    const submit = screen.getByRole("button", { name: /add note/i });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps submit disabled for a whitespace-only note", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseAppendNote.mockReturnValue(makeAppendMock({ mutate }));

    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[]} />);

    await user.type(screen.getByRole("textbox", { name: /add a note/i }), "   ");
    const submit = screen.getByRole("button", { name: /add note/i });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("enables submit and calls the mutation for non-blank text", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseAppendNote.mockReturnValue(makeAppendMock({ mutate }));

    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[]} />);

    await user.type(screen.getByRole("textbox", { name: /add a note/i }), "Looks good");
    await user.click(screen.getByRole("button", { name: /add note/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      { projectId: "p1", benchId: 1, caseId: "TC-001", text: "Looks good" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});

describe("NotesRail (TC-033: sentinel author + warning)", () => {
  it("renders the sentinel author and a visible warning", () => {
    const note = makeNote({
      author: { name: "Unknown author", email: "", isSentinel: true },
    });
    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[note]} />);

    expect(screen.getByText(/unknown author/i)).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/git identity is unset/i);
  });

  it("shows no warning when every note has a verified author", () => {
    render(<NotesRail projectId="p1" benchId={1} caseId="TC-001" notes={[makeNote()]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
