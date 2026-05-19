import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RouboConfig, Bench } from "@roubo/shared";
import { makeProject, makeBench, makeConfig } from "../test/fixtures.js";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("./bench-manager.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bench-manager.js")>();
  return {
    ...original,
    getBench: vi.fn(),
  };
});

vi.mock("./config-parser.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config-parser.js")>();
  return {
    ...original,
    buildTemplateContext: vi.fn(),
    resolveTemplate: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

import * as projectRegistry from "./project-registry.js";
import * as benchManager from "./bench-manager.js";
import { buildTemplateContext, resolveTemplate } from "./config-parser.js";
import { exec, execFile } from "node:child_process";
import { getResolvedTools, executeTool } from "./tool-launcher.js";

const toolConfig: RouboConfig["tools"] = [
  {
    name: "Web App",
    icon: "globe",
    type: "browser",
    url: "https://localhost:{{ports.frontend}}",
    requires: "frontend",
  },
  {
    name: "Rider",
    icon: "code",
    type: "shell",
    command: 'open -a "Rider" "{{workspace}}/sln"',
  },
];

const configWithTools = makeConfig({ tools: toolConfig });

const bench: Bench = makeBench({
  components: {
    frontend: { name: "frontend", status: "running", setupComplete: true },
    backend: { name: "backend", status: "stopped", setupComplete: true },
  },
  ports: { frontend: 5174, backend: 7018 },
});

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ config: configWithTools }));
  vi.mocked(benchManager.getBench).mockReturnValue(bench);
  vi.mocked(buildTemplateContext).mockReturnValue({
    ports: { frontend: 5174, backend: 7018 },
    portHttps: {},
    workspace: "/workspaces/test",
    components: {},
  });
  vi.mocked(resolveTemplate).mockImplementation((template) => {
    return template
      .replace("{{ports.frontend}}", "5174")
      .replace("{{workspace}}", "/workspaces/test");
  });
});

describe("getResolvedTools", () => {
  it("returns resolved tools with correct enabled state", () => {
    const tools = getResolvedTools("test-project", 1);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("Web App");
    expect(tools[0].enabled).toBe(true); // frontend is running
    expect(tools[1].name).toBe("Rider");
    expect(tools[1].enabled).toBe(true); // no requires
  });

  it("disables tool when required component is not running", () => {
    vi.mocked(benchManager.getBench).mockReturnValue(
      makeBench({
        components: {
          frontend: { name: "frontend", status: "stopped", setupComplete: true },
          backend: { name: "backend", status: "stopped", setupComplete: true },
        },
      }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].enabled).toBe(false); // frontend is stopped
  });

  it("returns empty array when no tools configured", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(makeProject({ config: makeConfig() }));

    const tools = getResolvedTools("test-project", 1);
    expect(tools).toEqual([]);
  });

  it("throws when project not found", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as any);

    expect(() => getResolvedTools("missing", 1)).toThrow();
  });

  it("throws when bench not found", () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    expect(() => getResolvedTools("test-project", 99)).toThrow();
  });

  it("overrides ports from assigned containers", () => {
    vi.mocked(benchManager.getBench).mockReturnValue(
      makeBench({
        components: {
          frontend: { name: "frontend", status: "running", setupComplete: true },
          database: { name: "database", status: "running", setupComplete: true },
        },
        assignedContainers: {
          database: { containerId: "abc", containerName: "db", port: 9999 },
        },
      }),
    );

    const ctx = {
      ports: { frontend: 5174, database: 1433 },
      portHttps: {},
      workspace: "/workspaces/test",
      components: {},
    };
    vi.mocked(buildTemplateContext).mockReturnValue(ctx);

    getResolvedTools("test-project", 1);

    // The context ports should have been overridden
    expect(ctx.ports.database).toBe(9999);
  });
});

describe("executeTool", () => {
  it("returns error for invalid index", async () => {
    const result = await executeTool("test-project", 1, 99);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid tool index");
  });

  it("returns error when tool is disabled", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(
      makeBench({
        components: {
          frontend: { name: "frontend", status: "stopped", setupComplete: true },
        },
      }),
    );

    const result = await executeTool("test-project", 1, 0);
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("executes browser tool", async () => {
    vi.mocked(execFile).mockImplementation((_file, _args, cb) => {
      (cb as (err: Error | null) => void)(null);
      return {} as any;
    });

    const result = await executeTool("test-project", 1, 0);
    expect(result.success).toBe(true);
    expect(execFile).toHaveBeenCalledWith("open", expect.any(Array), expect.any(Function));
  });

  it("executes shell tool with exec", async () => {
    vi.mocked(exec).mockImplementation((_command, _opts, cb) => {
      (cb as unknown as (err: Error | null) => void)(null);
      return {} as any;
    });

    const result = await executeTool("test-project", 1, 1);
    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'open -a "Rider" "/workspaces/test/sln"',
      { cwd: bench.workspacePath },
      expect.any(Function),
    );
  });

  it("returns error when exec fails for shell tool", async () => {
    vi.mocked(exec).mockImplementation((_command, _opts, cb) => {
      (cb as unknown as (err: Error | null) => void)(new Error("command failed"));
      return {} as any;
    });

    const result = await executeTool("test-project", 1, 1);
    expect(result.success).toBe(false);
    expect(result.error).toBe("command failed");
  });

  it("returns error when execFile fails for browser tool", async () => {
    vi.mocked(execFile).mockImplementation((_file, _args, cb) => {
      (cb as (err: Error | null) => void)(new Error("command failed"));
      return {} as any;
    });

    const result = await executeTool("test-project", 1, 0);
    expect(result.success).toBe(false);
    expect(result.error).toBe("command failed");
  });
});

describe("getResolvedTools requiresUserPicker", () => {
  const loginTool: RouboConfig["tools"] = [
    {
      name: "App",
      icon: "globe",
      type: "browser",
      url: "http://localhost:3000",
      login: {
        steps: [{ selector: "#email", action: "fill", value: "{{user.email}}" }],
      },
    },
  ];

  it("sets requiresUserPicker true when tool has login and config has users", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        config: makeConfig({
          tools: loginTool,
          users: [{ name: "Admin", properties: { email: "admin@test.com" } }],
        }),
      }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].requiresUserPicker).toBe(true);
  });

  it("sets requiresUserPicker false when tool has login but no users", () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ config: makeConfig({ tools: loginTool }) }),
    );

    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].requiresUserPicker).toBe(false);
  });

  it("sets requiresUserPicker false when tool has no login", () => {
    const tools = getResolvedTools("test-project", 1);
    expect(tools[0].requiresUserPicker).toBe(false);
  });
});

describe("executeTool with user", () => {
  const loginTool: RouboConfig["tools"] = [
    {
      name: "App",
      icon: "globe",
      type: "browser",
      url: "http://localhost:3000",
      login: {
        steps: [
          { selector: "#email", action: "fill", value: "{{user.email}}" },
          { selector: "#submit", action: "click" },
        ],
      },
    },
  ];

  const users = [{ name: "Admin", properties: { email: "admin@test.com", password: "pass123" } }];

  beforeEach(() => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ config: makeConfig({ tools: loginTool, users }) }),
    );
    vi.mocked(resolveTemplate).mockImplementation((template, ctx) => {
      return template
        .replace(/\{\{user\.([^}]+)\}\}/g, (_, key: string) => ctx.user?.[key] ?? "")
        .replace("{{ports.frontend}}", "5174")
        .replace("{{workspace}}", "/workspaces/test");
    });
    vi.mocked(execFile).mockImplementation((_file, _args, cb) => {
      (cb as (err: Error | null) => void)(null);
      return {} as any;
    });
  });

  it("resolves user placeholders in login step values when user is selected", async () => {
    const result = await executeTool("test-project", 1, 0, "Admin");
    expect(result.success).toBe(true);
    expect(result.login?.steps[0].value).toBe("admin@test.com");
  });

  it("preserves steps without value (click actions) unchanged", async () => {
    const result = await executeTool("test-project", 1, 0, "Admin");
    expect(result.success).toBe(true);
    expect(result.login?.steps[1].action).toBe("click");
    expect(result.login?.steps[1].value).toBeUndefined();
  });

  it("returns error when tool requires a user but none is selected", async () => {
    const result = await executeTool("test-project", 1, 0);
    expect(result.success).toBe(false);
    expect(result.error).toContain("requires a user selection");
  });

  it("resolves to empty string for missing user property", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({
        config: makeConfig({
          tools: loginTool,
          users: [{ name: "Admin", properties: { name: "Admin User" } }],
        }),
      }),
    );

    const result = await executeTool("test-project", 1, 0, "Admin");
    expect(result.success).toBe(true);
    expect(result.login?.steps[0].value).toBe("");
  });

  it("resolves {{user.*}} placeholders in URL when user is selected", async () => {
    const urlLoginTool: RouboConfig["tools"] = [
      {
        name: "App",
        icon: "globe",
        type: "browser",
        url: "http://app/login?email={{user.email}}",
        login: {
          steps: [{ selector: "#submit", action: "click" }],
        },
      },
    ];
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      makeProject({ config: makeConfig({ tools: urlLoginTool, users }) }),
    );

    const result = await executeTool("test-project", 1, 0, "Admin");
    expect(result.success).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "open",
      ["http://app/login?email=admin@test.com"],
      expect.any(Function),
    );
  });
});
