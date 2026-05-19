import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import {
  resolveTemplate,
  buildTemplateContext,
  resolveServiceEnv,
  stripSurroundingQuotes,
  parseConfig,
  validateConfigObject,
  type ResolvedTemplateContext,
} from "./config-parser.js";
import { makeConfig } from "../test/fixtures.js";

// --- Pure function tests (no mocking) ---

describe("resolveTemplate", () => {
  const ctx: ResolvedTemplateContext = {
    ports: { backend: 5000, frontend: 3000 },
    portHttps: { backend: false, frontend: true },
    workspace: "/home/.roubo/workspaces/project/bench-1",
    components: {
      db: { connection: "Server=localhost,5000;Database=mydb" },
      cache: {},
    },
  };

  it("substitutes port references", () => {
    expect(resolveTemplate("http://localhost:{{ports.backend}}", ctx)).toBe(
      "http://localhost:5000",
    );
  });

  it("substitutes workspace reference", () => {
    expect(resolveTemplate("cd {{workspace}}", ctx)).toBe(
      "cd /home/.roubo/workspaces/project/bench-1",
    );
  });

  it("substitutes service connection references", () => {
    expect(resolveTemplate("{{components.db.connection}}", ctx)).toBe(
      "Server=localhost,5000;Database=mydb",
    );
  });

  it("returns empty string for service without connection", () => {
    expect(resolveTemplate("{{components.cache.connection}}", ctx)).toBe("");
  });

  it("leaves unknown tokens verbatim", () => {
    expect(resolveTemplate("{{unknown}}", ctx)).toBe("{{unknown}}");
  });

  it("leaves unknown port names verbatim", () => {
    expect(resolveTemplate("{{ports.nonexistent}}", ctx)).toBe("{{ports.nonexistent}}");
  });

  it("handles multiple substitutions in one string", () => {
    const result = resolveTemplate("{{workspace}}/run --port={{ports.backend}}", ctx);
    expect(result).toBe("/home/.roubo/workspaces/project/bench-1/run --port=5000");
  });

  it("handles strings with no templates", () => {
    expect(resolveTemplate("plain text", ctx)).toBe("plain text");
  });

  it("handles service reference with wrong depth", () => {
    expect(resolveTemplate("{{components.db}}", ctx)).toBe("{{components.db}}");
    expect(resolveTemplate("{{components.db.other}}", ctx)).toBe("{{components.db.other}}");
  });

  it("substitutes urls with http when portHttps is false", () => {
    expect(resolveTemplate("{{urls.backend}}", ctx)).toBe("http://localhost:5000");
  });

  it("substitutes urls with https when portHttps is true", () => {
    expect(resolveTemplate("{{urls.frontend}}", ctx)).toBe("https://localhost:3000");
  });

  it("leaves unknown url names verbatim", () => {
    expect(resolveTemplate("{{urls.nonexistent}}", ctx)).toBe("{{urls.nonexistent}}");
  });
});

describe("resolveTemplate user context", () => {
  const ctx: ResolvedTemplateContext = {
    ports: { backend: 5000 },
    portHttps: {},
    workspace: "/wt",
    components: {},
    user: { email: "admin@example.com", password: "secret123", role: "admin" },
  };

  it("substitutes user.email", () => {
    expect(resolveTemplate("{{user.email}}", ctx)).toBe("admin@example.com");
  });

  it("substitutes user.password", () => {
    expect(resolveTemplate("{{user.password}}", ctx)).toBe("secret123");
  });

  it("substitutes arbitrary user property", () => {
    expect(resolveTemplate("{{user.role}}", ctx)).toBe("admin");
  });

  it("returns empty string for missing user property", () => {
    expect(resolveTemplate("{{user.nonexistent}}", ctx)).toBe("");
  });

  it("returns empty string when user is undefined (no user selected)", () => {
    const noUserCtx: ResolvedTemplateContext = { ...ctx, user: undefined };
    expect(resolveTemplate("{{user.email}}", noUserCtx)).toBe("");
  });

  it("resolves user placeholders alongside other placeholders", () => {
    expect(resolveTemplate("{{user.email}} on port {{ports.backend}}", ctx)).toBe(
      "admin@example.com on port 5000",
    );
  });
});

describe("buildTemplateContext", () => {
  it("allocates ports and resolves service connections", () => {
    const config = makeConfig({
      ports: { backend: { base: 5000 }, frontend: { base: 3000 } },
      components: {
        backend: { type: "process", command: "dotnet run --project src/Api/Api.csproj" },
        db: {
          type: "database",
          connection: { template: "Server=localhost,{{ports.backend}}" },
        },
      },
    });

    const ctx = buildTemplateContext(config, 1, "/workspace/path");
    expect(ctx.ports).toEqual({ backend: 5000, frontend: 3000 });
    expect(ctx.workspace).toBe("/workspace/path");
    expect(ctx.components.db.connection).toBe("Server=localhost,5000");
    expect(ctx.components.backend).toEqual({});
  });

  it("offsets ports by bench number", () => {
    const config = makeConfig({ ports: { web: { base: 3000 } } });
    const ctx = buildTemplateContext(config, 3, "/wt");
    expect(ctx.ports.web).toBe(3002);
  });

  it("populates portHttps from config", () => {
    const config = makeConfig({
      ports: {
        backend: { base: 5000 },
        frontend: { base: 3000, https: true },
      },
    });
    const ctx = buildTemplateContext(config, 1, "/wt");
    expect(ctx.portHttps).toEqual({ backend: false, frontend: true });
  });

  it("defaults portHttps to false when not specified", () => {
    const config = makeConfig({ ports: { web: { base: 3000 } } });
    const ctx = buildTemplateContext(config, 1, "/wt");
    expect(ctx.portHttps).toEqual({ web: false });
  });
});

describe("stripSurroundingQuotes", () => {
  it("strips matching double quotes", () => {
    expect(stripSurroundingQuotes('"hello"')).toBe("hello");
  });

  it("strips matching single quotes", () => {
    expect(stripSurroundingQuotes("'hello'")).toBe("hello");
  });

  it("does not strip mismatched quotes", () => {
    expect(stripSurroundingQuotes("\"hello'")).toBe("\"hello'");
  });

  it("returns empty string for empty quoted string", () => {
    expect(stripSurroundingQuotes('""')).toBe("");
  });

  it("does not strip single character", () => {
    expect(stripSurroundingQuotes('"')).toBe('"');
  });

  it("returns unquoted values unchanged", () => {
    expect(stripSurroundingQuotes("hello")).toBe("hello");
    expect(stripSurroundingQuotes("")).toBe("");
  });
});

describe("resolveServiceEnv", () => {
  it("resolves all env values through template engine", () => {
    const ctx: ResolvedTemplateContext = {
      ports: { api: 5000 },
      portHttps: {},
      workspace: "/wt",
      components: { db: { connection: "connstr" } },
    };
    const result = resolveServiceEnv(
      {
        PORT: "{{ports.api}}",
        ROOT: "{{workspace}}",
        DB: "{{components.db.connection}}",
        STATIC: "plain",
      },
      ctx,
    );
    expect(result).toEqual({
      PORT: "5000",
      ROOT: "/wt",
      DB: "connstr",
      STATIC: "plain",
    });
  });

  it("strips surrounding double quotes from resolved values", () => {
    const ctx: ResolvedTemplateContext = {
      ports: { api: 5000 },
      portHttps: {},
      workspace: "/wt",
      components: { db: { connection: "Server=localhost;Database=mydb" } },
    };
    const result = resolveServiceEnv(
      {
        CONN: '"{{components.db.connection}}"',
        URL: '"https://localhost:{{ports.api}}"',
      },
      ctx,
    );
    expect(result).toEqual({
      CONN: "Server=localhost;Database=mydb",
      URL: "https://localhost:5000",
    });
  });

  it("strips surrounding single quotes from resolved values", () => {
    const ctx: ResolvedTemplateContext = {
      ports: { api: 5000 },
      portHttps: {},
      workspace: "/wt",
      components: {},
    };
    const result = resolveServiceEnv({ URL: "'https://localhost:{{ports.api}}'" }, ctx);
    expect(result).toEqual({
      URL: "https://localhost:5000",
    });
  });

  it("does not strip internal quotes", () => {
    const ctx: ResolvedTemplateContext = {
      ports: {},
      portHttps: {},
      workspace: "/wt",
      components: {},
    };
    const result = resolveServiceEnv({ VAL: 'say "hello" world' }, ctx);
    expect(result).toEqual({ VAL: 'say "hello" world' });
  });
});

// --- Functions that use filesystem ---

describe("parseConfig", () => {
  it("returns invalid when config file does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors[0]).toContain("not found");
  });

  it("returns invalid when YAML is malformed", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("invalid: yaml: {{{}}}" as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors[0]).toContain("Failed to parse YAML");
  });

  it("returns invalid when schema validation fails", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("name: wrong-structure\n" as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid config when YAML is correct", () => {
    const validConfig = makeConfig();
    const yamlStr = JSON.stringify(validConfig);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    // YAML.parse can parse JSON as valid YAML
    vi.spyOn(fs, "readFileSync").mockReturnValue(yamlStr as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(true);
    if (!result.config) throw new Error("expected config");
    expect(result.config.project.name).toBe("test-project");
  });

  it("coerces numeric env values to strings", () => {
    // yaml.load parses unquoted 1433 as a number — coercion must fix this before validation
    const yamlContent = [
      "project:",
      "  name: test-project",
      "  displayName: Test Project",
      "  type: web",
      "  repo: org/test-project",
      "layout:",
      "  type: single-repo",
      "components:",
      "  db:",
      "    type: database",
      "    env:",
      "      MSSQL_PORT: 1433",
      "      SA_PASSWORD: secret",
      "ports:",
      "  db:",
      "    base: 5000",
      "benches:",
      "  max: 5",
    ].join("\n");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(yamlContent as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(true);
    if (!result.config) throw new Error("expected config");
    expect(result.config.components.db.env?.MSSQL_PORT).toBe("1433");
    expect(result.config.components.db.env?.SA_PASSWORD).toBe("secret");
  });

  it("coerces boolean env values to strings", () => {
    // yaml.load parses bare true/false as booleans — coercion must fix this before validation
    const yamlContent = [
      "project:",
      "  name: test-project",
      "  displayName: Test Project",
      "  type: web",
      "  repo: org/test-project",
      "layout:",
      "  type: single-repo",
      "components:",
      "  backend:",
      "    type: process",
      "    command: npm run dev",
      "    envVars:",
      "      DEBUG: true",
      "      VERBOSE: false",
      "ports:",
      "  backend:",
      "    base: 5000",
      "benches:",
      "  max: 5",
    ].join("\n");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(yamlContent as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(true);
    if (!result.config) throw new Error("expected config");
    expect(result.config.components.backend.envVars?.DEBUG).toBe("true");
    expect(result.config.components.backend.envVars?.VERBOSE).toBe("false");
  });

  it("coerces testing.env numeric values to strings", () => {
    const yamlContent = [
      "project:",
      "  name: test-project",
      "  displayName: Test Project",
      "  type: web",
      "  repo: org/test-project",
      "layout:",
      "  type: single-repo",
      "components:",
      "  backend:",
      "    type: process",
      "    command: npm run dev",
      "ports:",
      "  backend:",
      "    base: 5000",
      "benches:",
      "  max: 5",
      "inspection:",
      "  framework: jest",
      "  directory: tests",
      "  command: npm test",
      "  env:",
      "    TEST_PORT: 9999",
      "    CI: true",
    ].join("\n");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(yamlContent as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(true);
    if (!result.config) throw new Error("expected config");
    expect(result.config.inspection?.env?.TEST_PORT).toBe("9999");
    expect(result.config.inspection?.env?.CI).toBe("true");
  });

  it('rejects a submodule key of "." via parseConfig', () => {
    const config = makeConfig({
      layout: {
        type: "meta-repo",
        submodules: { ".": "git@github.com:org/root.git", "sub-a": "git@github.com:org/sub-a.git" },
      },
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(config) as any);
    const result = parseConfig("/some/repo");
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes('"."') && e.includes("reserved"))).toBe(true);
  });
});

describe("users schema validation", () => {
  it("accepts a config with a valid users array", () => {
    const config = makeConfig({
      users: [{ name: "Admin User", properties: { email: "admin@example.com", role: "admin" } }],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("accepts a config without users (backward compatibility)", () => {
    const config = makeConfig();
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("accepts an empty users array", () => {
    const config = makeConfig({ users: [] });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("rejects a user entry missing name", () => {
    const config = makeConfig({
      users: [{ name: undefined as unknown as string, properties: { email: "a@b.com" } }],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects a user entry missing properties", () => {
    const config = makeConfig({
      users: [{ name: "Test", properties: undefined as unknown as Record<string, string> }],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes("properties"))).toBe(true);
  });

  it("rejects a user entry with non-string property values", () => {
    const config = makeConfig({
      users: [{ name: "Test", properties: { count: 42 as unknown as string } }],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects a user entry with extra fields", () => {
    const config = makeConfig({
      users: [
        { name: "Test", properties: {}, extra: "field" } as unknown as {
          name: string;
          properties: Record<string, string>;
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects users when not an array", () => {
    const config = { ...makeConfig(), users: { name: "Admin" } };
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes("users"))).toBe(true);
  });

  it("rejects a user entry with an empty name", () => {
    const config = makeConfig({ users: [{ name: "", properties: { email: "a@b.com" } }] });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects duplicate user entries", () => {
    const user = { name: "Alice", properties: { email: "alice@example.com" } };
    const config = makeConfig({ users: [user, user] });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });
});

describe("login schema validation", () => {
  const browserTool = {
    name: "Open App",
    icon: "globe",
    type: "browser" as const,
    url: "http://localhost:3000",
  };
  const shellTool = {
    name: "Open Shell",
    icon: "terminal",
    type: "shell" as const,
    command: "bash",
  };

  it("accepts a browser tool with valid login steps", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: {
            steps: [
              { selector: "input[name='email']", action: "fill", value: "{{user.email}}" },
              { selector: "input[name='password']", action: "fill", value: "{{user.password}}" },
              { selector: "button[type='submit']", action: "click" },
            ],
          },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("accepts a browser tool without login (backward compatibility)", () => {
    const config = makeConfig({ tools: [browserTool] });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("rejects login on a shell-type tool", () => {
    const config = makeConfig({
      tools: [
        {
          ...shellTool,
          login: { steps: [{ selector: "input", action: "click" }] },
        } as unknown as typeof shellTool,
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects login with an empty steps array", () => {
    const config = makeConfig({
      tools: [{ ...browserTool, login: { steps: [] } } as unknown as typeof browserTool],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects a step missing selector", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: { steps: [{ selector: undefined as unknown as string, action: "click" }] },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes("selector"))).toBe(true);
  });

  it("rejects a step missing action", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: { steps: [{ selector: "input", action: undefined as unknown as "fill" }] },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes("action"))).toBe(true);
  });

  it("rejects a step with an invalid action value", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: { steps: [{ selector: "input", action: "hover" as unknown as "click" }] },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects a fill step without a value", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: { steps: [{ selector: "input[name='email']", action: "fill" as const }] },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("accepts a click step without a value", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: { steps: [{ selector: "button[type='submit']", action: "click" as const }] },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("rejects a fill step with an empty value", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: {
            steps: [{ selector: "input[name='email']", action: "fill" as const, value: "" }],
          },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("accepts a fill step with a whitespace-only value", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: {
            steps: [{ selector: "input[name='email']", action: "fill" as const, value: " " }],
          },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });

  it("rejects login with extra fields", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: { steps: [{ selector: "input", action: "click" }], extra: "field" } as unknown as {
            steps: [];
          },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });

  it("rejects a step with extra fields", () => {
    const config = makeConfig({
      tools: [
        {
          ...browserTool,
          login: {
            steps: [
              { selector: "input", action: "click", extra: "field" } as unknown as {
                selector: string;
                action: "click";
              },
            ],
          },
        },
      ],
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
  });
});

describe("validateConfigObject", () => {
  it("returns valid for a correct config object", () => {
    const config = makeConfig();
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
    expect(result.config).toEqual(config);
  });

  it("returns errors for missing required fields", () => {
    const result = validateConfigObject({ project: { name: "test" } });
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns errors for empty object", () => {
    const result = validateConfigObject({});
    expect(result.valid).toBe(false);
  });

  it('rejects a submodule key of "."', () => {
    const config = makeConfig({
      layout: {
        type: "meta-repo",
        submodules: { ".": "git@github.com:org/root.git", "sub-a": "git@github.com:org/sub-a.git" },
      },
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(false);
    if (!result.errors) throw new Error("expected errors");
    expect(result.errors.some((e) => e.includes('"."') && e.includes("reserved"))).toBe(true);
  });

  it('accepts submodule keys that start with "." but are not exactly "."', () => {
    const config = makeConfig({
      layout: {
        type: "meta-repo",
        submodules: {
          ".hidden": "git@github.com:org/hidden.git",
          "..": "git@github.com:org/dotdot.git",
        },
      },
    });
    const result = validateConfigObject(config);
    expect(result.valid).toBe(true);
  });
});
