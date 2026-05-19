// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SubdirectoryPicker from "./SubdirectoryPicker";

vi.mock("../../hooks/useFilesystem");
vi.mock("../FilePathLabel", () => ({
  default: ({ path }: { path: string }) => <span data-testid="file-path-label">{path}</span>,
}));
import { useBrowseDirectory } from "../../hooks/useFilesystem";

const mockUseBrowseDirectory = vi.mocked(useBrowseDirectory);

const mockDirData = {
  path: "/repo/tests",
  entries: [
    {
      name: "unit",
      path: "/repo/tests/unit",
      isDirectory: true,
      hasGitRepo: false,
    },
    {
      name: "e2e",
      path: "/repo/tests/e2e",
      isDirectory: true,
      hasGitRepo: false,
    },
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

describe("SubdirectoryPicker", () => {
  it("renders the label and text input", () => {
    render(
      <SubdirectoryPicker
        label="Directory"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    expect(screen.getByText("Directory")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("tests")).toBeInTheDocument();
  });

  it("opens the picker panel when browse button is clicked", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("unit")).toBeInTheDocument();
    expect(screen.getByText("e2e")).toBeInTheDocument();
  });

  it("calls onChange and closes when Select is clicked", async () => {
    const onChange = vi.fn();
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={onChange}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: /select/i }));
    expect(onChange).toHaveBeenCalled();
  });

  it("shows loading spinner while browsing", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows an error message on browse failure", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("denied"),
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("denied")).toBeInTheDocument();
  });

  it("navigates into a directory on click", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByText("unit"));
    expect(mockUseBrowseDirectory).toHaveBeenCalledWith("/repo/tests/unit", false, true);
  });

  it("closes picker when button clicked again", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    expect(screen.getByText("unit")).toBeInTheDocument();
    await userEvent.click(btn);
    expect(screen.queryByText("unit")).not.toBeInTheDocument();
  });

  it("closes picker when Escape key is pressed", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("unit")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("unit")).not.toBeInTheDocument();
  });

  it("calls onChange and closes on double-click of directory entry", async () => {
    const onChange = vi.fn();
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={onChange}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.dblClick(screen.getByText("unit"));
    expect(onChange).toHaveBeenCalledWith("tests/unit");
    expect(screen.queryByText("unit")).not.toBeInTheDocument();
  });

  it("closes picker when Cancel button is clicked", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    expect(screen.getByText("unit")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByText("unit")).not.toBeInTheDocument();
  });

  it("toggles show hidden directories", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: mockDirData,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    await userEvent.click(screen.getByRole("button", { name: /show hidden directories/i }));
    expect(mockUseBrowseDirectory).toHaveBeenCalledWith(expect.any(String), true, true);
  });

  it("shows No subdirectories when entries are empty", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: { path: "/repo", entries: [] },
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value=""
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    expect(screen.getByText("No subdirectories")).toBeInTheDocument();
  });

  it("shows text input in editing mode when value exists and FilePathLabel is clicked", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value="tests"
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    // FilePathLabel button should be visible instead of input
    expect(screen.getByTestId("file-path-label")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("file-path-label"));
    // After clicking, should enter editing mode and show the text input
    expect(screen.getByPlaceholderText("tests")).toBeInTheDocument();
  });

  it("navigates to parent directory when go-up button is clicked", async () => {
    mockUseBrowseDirectory.mockReturnValue({
      data: { path: "/repo/tests/unit", entries: [] },
      isLoading: false,
      error: null,
    } as never);
    render(
      <SubdirectoryPicker
        label="Dir"
        placeholder="tests"
        value="tests/unit"
        onChange={vi.fn()}
        basePath="/repo"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /browse/i }));
    await userEvent.click(screen.getByRole("button", { name: /\.\./i }));
    expect(mockUseBrowseDirectory).toHaveBeenCalledWith(
      "/repo/tests",
      expect.any(Boolean),
      expect.any(Boolean),
    );
  });
});
