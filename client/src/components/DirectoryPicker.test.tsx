// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DirectoryPicker from "./DirectoryPicker";

vi.mock("../hooks/useFilesystem");
import { useBrowseDirectory } from "../hooks/useFilesystem";

const mockUseBrowseDirectory = vi.mocked(useBrowseDirectory);

const mockDirData = {
  path: "/home/user",
  entries: [
    { name: "projects", path: "/home/user/projects", isDirectory: true, hasGitRepo: true },
    { name: "docs", path: "/home/user/docs", isDirectory: true, hasGitRepo: false },
    { name: "file.txt", path: "/home/user/file.txt", isDirectory: false, hasGitRepo: false },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mockUseBrowseDirectory.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
  } as never);
});

describe("DirectoryPicker", () => {
  it("renders the text input", () => {
    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("opens the picker when the browse button is clicked", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    const browseBtn = screen.getAllByRole("button")[0];
    await userEvent.click(browseBtn);
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("shows loading spinner while browsing", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);
    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    const browseBtn = screen.getAllByRole("button")[0];
    await userEvent.click(browseBtn);
    // Spinner should appear
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error message when browse fails", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Permission denied"),
    } as never);
    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    const browseBtn = screen.getAllByRole("button")[0];
    await userEvent.click(browseBtn);
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
  });

  it("calls onChange when select button is clicked", async () => {
    const onChange = vi.fn();
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(<DirectoryPicker value="" onChange={onChange} />);
    const browseBtn = screen.getAllByRole("button")[0];
    await userEvent.click(browseBtn);
    await userEvent.click(screen.getByRole("button", { name: /select/i }));
    expect(onChange).toHaveBeenCalledWith("/home/user");
  });

  it("shows hidden files toggle button", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    const browseBtn = screen.getAllByRole("button")[0];
    await userEvent.click(browseBtn);
    // There should be a toggle for hidden files
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(2);
  });

  it("closes picker on second button click", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    const browseBtn = screen.getAllByRole("button")[0];
    await userEvent.click(browseBtn);
    expect(screen.getByText("projects")).toBeInTheDocument();
    await userEvent.click(browseBtn);
    expect(screen.queryByText("projects")).not.toBeInTheDocument();
  });
});
