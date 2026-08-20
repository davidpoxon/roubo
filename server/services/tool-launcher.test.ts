import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bench, RouboConfig } from "@roubo/shared";
import { makeBench, makeConfig, makeProject } from "../test/fixtures.js";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("./bench-manager.js", () => ({
  getBench: vi.fn(),
  BenchError: class BenchError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("./state.js", () => ({
  loadSettings: vi.fn(() => ({ jigs: {} })),
}));

const execFileMock = vi.fn();
const execMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], cb: (err: Error | null) => void) => {
    execFileMock(file, args);
    cb(null);
  },
  exec: (command: string, opts: unknown, cb: (err: Error | null) => void) => {
    execMock(command, opts);
    cb(null);
  },
}));

import * as projectRegistry from "./project-registry.js";
import * as benchManager from "./bench-manager.js";
import { getResolvedTools, executeTool } from "./tool-launcher.js";

// A component that runs to completion and reports the URL it minted: the
// gsheets-style case #833 was filed for. It has no `ports` entry at all, so the
// port-derived `{{urls.deploy}}` form cannot produce anything for it.
const REPORTED_URL = "https://docs.google.com/spreadsheets/d/abc123/edit";

function configWithDeployTool(): RouboConfig {
  return makeConfig({
    components: {
      backend: { plugin: { id: "process" }, config: { command: "run" } },
      deploy: { plugin: { id: "process" }, config: { command: "deploy" } },
    },
    ports: { backend: { base: 5000 } },
    tools: [
      { name: "Open sheet", type: "browser", url: "{{urls.deploy}}", requires: "deploy" },
      { name: "Open backend", type: "browser", url: "{{urls.backend}}", requires: "backend" },
    ],
  });
}

function benchWith(components: Bench["components"]): Bench {
  return makeBench({ ports: { backend: 5000 }, components });
}

function seed(bench: Bench, config = configWithDeployTool()): void {
  vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ config }));
  vi.mocked(benchManager.getBench).mockReturnValue(bench);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getResolvedTools", () => {
  it("resolves {{urls.<component>}} to the URL the component reported at runtime", () => {
    seed(
      benchWith({
        backend: { name: "backend", status: "running", setupComplete: true },
        deploy: { name: "deploy", status: "completed", setupComplete: true, url: REPORTED_URL },
      }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].url).toBe(REPORTED_URL);
  });

  it("prefers a reported URL over the port-derived one", () => {
    seed(
      benchWith({
        backend: {
          name: "backend",
          status: "running",
          setupComplete: true,
          url: "https://backend.example.test",
        },
        deploy: { name: "deploy", status: "completed", setupComplete: true },
      }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[1].url).toBe("https://backend.example.test");
  });

  it("leaves the template unresolved when a portless component has reported nothing", () => {
    seed(
      benchWith({
        backend: { name: "backend", status: "running", setupComplete: true },
        deploy: { name: "deploy", status: "completed", setupComplete: true },
      }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].url).toBe("{{urls.deploy}}");
    expect(tools[1].url).toBe("http://localhost:5000");
  });

  it("enables a tool whose required component ran to completion", () => {
    seed(
      benchWith({
        backend: { name: "backend", status: "running", setupComplete: true },
        deploy: { name: "deploy", status: "completed", setupComplete: true, url: REPORTED_URL },
      }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].enabled).toBe(true);
    expect(tools[1].enabled).toBe(true);
  });

  it("disables a tool whose required component has not run", () => {
    seed(
      benchWith({
        backend: { name: "backend", status: "stopped", setupComplete: true },
        deploy: { name: "deploy", status: "stopped", setupComplete: true },
      }),
    );

    expect(getResolvedTools("test-project", 1).map((t) => t.enabled)).toEqual([false, false]);
  });
});

describe("executeTool", () => {
  it("opens the runtime-reported URL for a portless component", async () => {
    seed(
      benchWith({
        backend: { name: "backend", status: "running", setupComplete: true },
        deploy: { name: "deploy", status: "completed", setupComplete: true, url: REPORTED_URL },
      }),
    );

    const result = await executeTool("test-project", 1, 0);

    expect(result.success).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith("open", [REPORTED_URL]);
  });

  it("refuses a tool whose required component has not run", async () => {
    seed(
      benchWith({
        backend: { name: "backend", status: "running", setupComplete: true },
        deploy: { name: "deploy", status: "stopped", setupComplete: true },
      }),
    );

    const result = await executeTool("test-project", 1, 0);

    expect(result.success).toBe(false);
    expect(result.error).toContain("is disabled");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
