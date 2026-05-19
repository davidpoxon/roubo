import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockChild } from "../test/fixtures.js";

vi.mock("tree-kill", () => ({ default: vi.fn() }));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("./bench-manager.js", () => ({
  getBench: vi.fn(),
}));

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("./config-parser.js", () => ({
  buildTemplateContext: vi
    .fn()
    .mockReturnValue({ ports: {}, portHttps: {}, workspace: "/workspace", components: {} }),
  resolveServiceEnv: vi.fn().mockImplementation((env: Record<string, string>) => env),
}));

vi.mock("./exec.js", () => ({
  parseCommand: vi.fn().mockImplementation((cmd: string) => cmd.split(" ")),
}));

const mockCreateNotification = vi.fn();
const mockDismissOne = vi.fn();
vi.mock("./notification.js", () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  dismissOne: (...args: unknown[]) => mockDismissOne(...args),
}));

import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";

beforeEach(() => {
  vi.resetModules();
  mockSpawn.mockReset();
  mockCreateNotification.mockReset();
  mockDismissOne.mockReset();
});

async function loadModule() {
  return await import("./inspection-runner.js");
}

describe("startInspection", () => {
  it("spawns a test process and returns test run", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: {
          framework: "playwright",
          directory: "tests",
          command: "npx playwright test",
          env: { CI: "true" },
        },
      },
    } as any);

    const { startInspection } = await loadModule();
    const run = startInspection("project1", 1);

    expect(run.id).toMatch(/^inspection-/);
    expect(run.status).toBe("running");
    expect(run.projectId).toBe("project1");
    expect(run.benchId).toBe(1);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("throws when no inspection config", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({ config: {} } as any);

    const { startInspection } = await loadModule();
    expect(() => startInspection("project1", 1)).toThrow("No inspection configuration");
  });

  it("throws when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const { startInspection } = await loadModule();
    expect(() => startInspection("project1", 1)).toThrow("Bench not found");
  });

  it("throws when a test is already running", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    expect(() => startInspection("project1", 1)).toThrow("already active");
  });

  it("appends filter as --grep argument", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    const run = startInspection("project1", 1, "my filter");

    expect(run.filter).toBe("my filter");
    expect(mockSpawn).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["--grep", "my filter"]),
      expect.any(Object),
    );
  });

  it("spawns with shell: false", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    expect(mockSpawn).toHaveBeenCalledWith(
      "npm",
      expect.any(Array),
      expect.objectContaining({ shell: false }),
    );
  });

  it("rejects filter with shell metacharacters", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    expect(() => startInspection("project1", 1, "test; rm -rf /")).toThrow("invalid characters");
    expect(() => startInspection("project1", 1, "test | cat")).toThrow("invalid characters");
    expect(() => startInspection("project1", 1, "$(whoami)")).toThrow("invalid characters");
  });
});

describe("getInspection", () => {
  it("returns undefined when no run exists", async () => {
    const { getInspection } = await loadModule();
    expect(getInspection("project1", 1)).toBeUndefined();
  });

  it("returns the current run", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection, getInspection } = await loadModule();
    const started = startInspection("project1", 1);

    const run = getInspection("project1", 1);
    expect(run?.id).toBe(started.id);
    expect(run?.status).toBe("running");
  });
});

describe("getInspectionOutput", () => {
  it("returns incremental output with since param", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection, getInspectionOutput } = await loadModule();
    startInspection("project1", 1);

    // Simulate stdout output
    child.stdout?.emit("data", Buffer.from("line 1\nline 2\nline 3\n"));

    const result = getInspectionOutput("project1", 1, 1);
    expect(result?.output).toEqual(["line 2", "line 3"]);
  });
});

describe("output trimming", () => {
  it("trims output exceeding MAX_OUTPUT_LINES", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection, getInspectionOutput } = await loadModule();
    startInspection("project1", 1);

    // Emit a large chunk of output exceeding 10000 lines
    const lines = Array.from({ length: 10_500 }, (_, i) => `line-${i}`).join("\n");
    child.stdout?.emit("data", Buffer.from(lines));

    const result = getInspectionOutput("project1", 1);
    expect(result?.run.output.length).toBeLessThanOrEqual(10_000);
    // The oldest lines should have been trimmed
    expect(result?.run.output[0]).toBe("line-500");
  });
});

describe("inspection-complete notification", () => {
  it("emits inspection-complete notification with passed: true on exit code 0", async () => {
    const bench = { workspacePath: "/workspace", notifications: [] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("close", 0);

    expect(mockCreateNotification).toHaveBeenCalledWith(bench, "inspection-complete", undefined, {
      passed: true,
    });
  });

  it("emits inspection-complete notification with passed: false on non-zero exit code", async () => {
    const bench = { workspacePath: "/workspace", notifications: [] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("close", 1);

    expect(mockCreateNotification).toHaveBeenCalledWith(bench, "inspection-complete", undefined, {
      passed: false,
    });
  });

  it("emits inspection-complete with passed: false when exit code is null (signal kill)", async () => {
    const bench = { workspacePath: "/workspace", notifications: [] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("close", null);

    expect(mockCreateNotification).toHaveBeenCalledWith(bench, "inspection-complete", undefined, {
      passed: false,
    });
  });

  it("does not emit notification when bench no longer exists at close time", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench)
      .mockReturnValueOnce({ workspacePath: "/workspace", notifications: [] } as any) // startInspection
      .mockReturnValueOnce(undefined); // close handler: bench was deleted
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("close", 0);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("dismisses stale inspection-complete notification before creating a new one", async () => {
    const staleNotification = { id: "stale-id", type: "inspection-complete" };
    const bench = { workspacePath: "/workspace", notifications: [staleNotification] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("close", 0);

    expect(mockDismissOne).toHaveBeenCalledWith(bench, "stale-id");
    expect(mockCreateNotification).toHaveBeenCalledWith(bench, "inspection-complete", undefined, {
      passed: true,
    });
  });

  it("emits inspection-complete with passed: false when process errors", async () => {
    const bench = { workspacePath: "/workspace", notifications: [] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("error", new Error("ENOENT"));

    expect(mockCreateNotification).toHaveBeenCalledWith(bench, "inspection-complete", undefined, {
      passed: false,
    });
  });

  it("does not emit notification when process exits after user stops inspection", async () => {
    const bench = { workspacePath: "/workspace", notifications: [] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection, stopInspection } = await loadModule();
    startInspection("project1", 1);
    stopInspection("project1", 1);

    // Process finally exits after SIGTERM
    child.emit("close", null);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("dismisses stale inspection-complete before creating a new one on error", async () => {
    const staleNotification = { id: "stale-id", type: "inspection-complete" };
    const bench = { workspacePath: "/workspace", notifications: [staleNotification] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("error", new Error("ENOENT"));

    expect(mockDismissOne).toHaveBeenCalledWith(bench, "stale-id");
    expect(mockCreateNotification).toHaveBeenCalledWith(bench, "inspection-complete", undefined, {
      passed: false,
    });
  });

  it("does not emit a second notification when close fires after error (spawn failure)", async () => {
    const bench = { workspacePath: "/workspace", notifications: [] } as any;
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue(bench);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("error", new Error("ENOENT"));
    mockCreateNotification.mockClear();
    mockDismissOne.mockClear();

    // Node fires close after error on spawn failure
    child.emit("close", null);

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockDismissOne).not.toHaveBeenCalled();
  });

  it("does not emit notification when bench no longer exists at error time", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench)
      .mockReturnValueOnce({ workspacePath: "/workspace", notifications: [] } as any) // startInspection
      .mockReturnValueOnce(undefined); // error handler: bench was deleted
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection } = await loadModule();
    startInspection("project1", 1);

    child.emit("error", new Error("ENOENT"));

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe("stopInspection", () => {
  it("returns false when no active run", async () => {
    const { stopInspection } = await loadModule();
    expect(stopInspection("project1", 1)).toBe(false);
  });

  it("stops a running test", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    vi.mocked(benchManager.getBench).mockReturnValue({
      workspacePath: "/workspace",
      notifications: [],
    } as any);
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: {
        inspection: { framework: "vitest", directory: ".", command: "npm test" },
      },
    } as any);

    const { startInspection, stopInspection, getInspection } = await loadModule();
    startInspection("project1", 1);

    const result = stopInspection("project1", 1);
    expect(result).toBe(true);

    const run = getInspection("project1", 1);
    expect(run?.status).toBe("aborted");
    expect(run?.output).toContain("[aborted by user]");
  });
});
