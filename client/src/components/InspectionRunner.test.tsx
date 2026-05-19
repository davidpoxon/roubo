// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InspectionRunner from "./InspectionRunner";

vi.mock("../hooks/useInspection");
vi.mock("../hooks/useElapsed");

import { useInspectionRun, useStartInspection, useAbortInspection } from "../hooks/useInspection";
import { useElapsed } from "../hooks/useElapsed";

const mockUseInspectionRun = vi.mocked(useInspectionRun);
const mockUseStartInspection = vi.mocked(useStartInspection);
const mockUseAbortInspection = vi.mocked(useAbortInspection);
const mockUseElapsed = vi.mocked(useElapsed);

function makeStartMock(overrides = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides } as unknown as ReturnType<
    typeof useStartInspection
  >;
}
function makeAbortMock(overrides = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides } as unknown as ReturnType<
    typeof useAbortInspection
  >;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseInspectionRun.mockReturnValue({ data: undefined } as unknown as ReturnType<
    typeof useInspectionRun
  >);
  mockUseStartInspection.mockReturnValue(makeStartMock());
  mockUseAbortInspection.mockReturnValue(makeAbortMock());
  mockUseElapsed.mockReturnValue(null);

  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe("InspectionRunner", () => {
  it("renders the filter input and Run All button when idle", () => {
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByPlaceholderText(/filter tests/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run all/i })).toBeInTheDocument();
  });

  it('shows "Run tests to see output here" when no run data', () => {
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByText(/run tests to see output here/i)).toBeInTheDocument();
  });

  it("calls startInspection when Run All is clicked", async () => {
    const mutate = vi.fn();
    mockUseStartInspection.mockReturnValue(makeStartMock({ mutate }));
    render(<InspectionRunner projectId="p1" benchId={1} />);
    await userEvent.click(screen.getByRole("button", { name: /run all/i }));
    expect(mutate).toHaveBeenCalledWith({ projectId: "p1", benchId: 1, filter: undefined });
  });

  it('shows "Run Filtered" label when filter is set', async () => {
    render(<InspectionRunner projectId="p1" benchId={1} />);
    await userEvent.type(screen.getByPlaceholderText(/filter tests/i), "login");
    expect(screen.getByRole("button", { name: /run filtered/i })).toBeInTheDocument();
  });

  it("shows Stop button and status bar when running", () => {
    mockUseInspectionRun.mockReturnValue({
      data: { status: "running", output: [], startedAt: new Date().toISOString() },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("calls abortInspection when Stop is clicked", async () => {
    const mutate = vi.fn();
    mockUseAbortInspection.mockReturnValue(makeAbortMock({ mutate }));
    mockUseInspectionRun.mockReturnValue({
      data: { status: "running", output: [], startedAt: new Date().toISOString() },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(mutate).toHaveBeenCalledWith({ projectId: "p1", benchId: 1 });
  });

  it("renders output lines", () => {
    mockUseInspectionRun.mockReturnValue({
      data: { status: "passed", output: ["test passed", "all done"] },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByText("test passed")).toBeInTheDocument();
    expect(screen.getByText("all done")).toBeInTheDocument();
  });

  it("shows Passed status", () => {
    mockUseInspectionRun.mockReturnValue({
      data: { status: "passed", output: [] },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByText("Passed")).toBeInTheDocument();
  });

  it("shows Failed status", () => {
    mockUseInspectionRun.mockReturnValue({
      data: { status: "failed", output: [] },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows elapsed time when running", () => {
    mockUseElapsed.mockReturnValue("42s");
    mockUseInspectionRun.mockReturnValue({
      data: { status: "running", output: [], startedAt: new Date().toISOString() },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByText("42s")).toBeInTheDocument();
  });

  it("shows exit code when run is complete", () => {
    mockUseInspectionRun.mockReturnValue({
      data: { status: "passed", output: [], exitCode: 0 },
    } as unknown as ReturnType<typeof useInspectionRun>);
    render(<InspectionRunner projectId="p1" benchId={1} />);
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });
});
