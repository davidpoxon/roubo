import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegisteredProject, RouboConfig } from "@roubo/shared";
import {
  collectDesiredRepos,
  deriveAndPersistGithubSources,
  deriveGithubSources,
  parseGitHubRepoFromUrl,
} from "./derive-github-sources.js";
import * as projectRegistry from "./project-registry.js";
import * as pluginManager from "./plugin-manager.js";

vi.mock("./project-registry.js", () => ({
  getProject: vi.fn(),
  reloadConfig: vi.fn(),
}));
vi.mock("./plugin-manager.js", () => ({
  invoke: vi.fn(),
}));

let tmpDir: string;
let consoleWarn: ReturnType<typeof vi.spyOn>;

function baseConfig(): RouboConfig {
  return {
    project: {
      name: "demo",
      displayName: "Demo",
      type: "web",
      repo: "acme/demo",
    },
    layout: { type: "single-repo" },
    components: { server: { type: "process", command: "npm start" } },
    ports: { server: { base: 3000 } },
    benches: { max: 5 },
  } as unknown as RouboConfig;
}

function projectFor(config: RouboConfig): RegisteredProject {
  return {
    id: "demo",
    repoPath: tmpDir,
    config: structuredClone(config),
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derive-sources-"));
  // Derivation logs warnings on every fallback path; silence by default and
  // re-spy in the specific tests that need to assert on the message.
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseGitHubRepoFromUrl", () => {
  it("parses SSH URLs", () => {
    expect(parseGitHubRepoFromUrl("git@github.com:acme/demo.git")).toBe("acme/demo");
    expect(parseGitHubRepoFromUrl("git@github.com:acme/demo")).toBe("acme/demo");
  });

  it("parses HTTPS URLs", () => {
    expect(parseGitHubRepoFromUrl("https://github.com/acme/demo.git")).toBe("acme/demo");
    expect(parseGitHubRepoFromUrl("https://github.com/acme/demo")).toBe("acme/demo");
  });

  it("returns null for unparseable URLs", () => {
    expect(parseGitHubRepoFromUrl("not-a-url")).toBeNull();
    expect(parseGitHubRepoFromUrl("git@github.com:")).toBeNull();
  });
});

describe("collectDesiredRepos", () => {
  it("returns just the root repo when there are no submodules", () => {
    const config = baseConfig();
    expect(collectDesiredRepos(config, tmpDir)).toEqual(["acme/demo"]);
  });

  it("includes submodules whose .gitmodules URL parses to owner/repo", () => {
    const config = baseConfig();
    config.layout = {
      type: "meta-repo",
      submodules: { backend: "apps/backend", frontend: "apps/frontend" },
    };
    fs.writeFileSync(
      path.join(tmpDir, ".gitmodules"),
      [
        '[submodule "backend"]',
        "  path = apps/backend",
        "  url = git@github.com:acme/backend.git",
        '[submodule "frontend"]',
        "  path = apps/frontend",
        "  url = https://github.com/acme/frontend",
        "",
      ].join("\n"),
    );
    expect(collectDesiredRepos(config, tmpDir)).toEqual([
      "acme/demo",
      "acme/backend",
      "acme/frontend",
    ]);
  });

  it("silently drops submodules whose URL we cannot resolve", () => {
    const config = baseConfig();
    config.layout = {
      type: "meta-repo",
      submodules: { weird: "apps/weird", ok: "apps/ok" },
    };
    fs.writeFileSync(
      path.join(tmpDir, ".gitmodules"),
      [
        '[submodule "weird"]',
        "  path = apps/weird",
        "  url = not-a-real-url",
        '[submodule "ok"]',
        "  path = apps/ok",
        "  url = git@github.com:acme/ok.git",
        "",
      ].join("\n"),
    );
    expect(collectDesiredRepos(config, tmpDir)).toEqual(["acme/demo", "acme/ok"]);
  });

  it("dedupes when the root repo and a submodule resolve to the same name", () => {
    const config = baseConfig();
    config.layout = {
      type: "meta-repo",
      submodules: { self: "self" },
    };
    fs.writeFileSync(
      path.join(tmpDir, ".gitmodules"),
      ['[submodule "self"]', "  path = self", "  url = git@github.com:acme/demo.git", ""].join(
        "\n",
      ),
    );
    expect(collectDesiredRepos(config, tmpDir)).toEqual(["acme/demo"]);
  });
});

describe("deriveGithubSources", () => {
  it("returns an empty result when the project has no repo set", async () => {
    const config = baseConfig();
    delete (config.project as { repo?: string }).repo;
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(config));

    const result = await deriveGithubSources("demo");

    expect(result.sources).toEqual({});
    expect(result.preview.repos).toEqual([]);
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("filters the plugin's candidate list down to the project's repos and matching-owner projects", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(baseConfig()));
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      shape: "categorized-multi-list",
      categories: [
        {
          id: "Repository",
          items: [
            { externalId: "acme/demo", label: "acme/demo" },
            { externalId: "acme/other", label: "acme/other" },
            { externalId: "stranger/foreign", label: "stranger/foreign" },
          ],
        },
        {
          id: "Project",
          items: [
            { externalId: "acme/#1", label: "Planning" },
            { externalId: "acme/#2", label: "Bugs" },
            { externalId: "stranger/#3", label: "Theirs" },
          ],
        },
      ],
    });

    const result = await deriveGithubSources("demo");

    expect(result.sources).toEqual({
      Repository: [
        {
          externalId: "acme/demo",
          includeCodeQLAlerts: true,
          includeSecretScanningAlerts: true,
          includeDependabotAlerts: true,
        },
      ],
      Project: [{ externalId: "acme/#1" }, { externalId: "acme/#2" }],
    });
    expect(result.preview.repos).toEqual(["acme/demo"]);
    expect(result.preview.projects.map((p) => p.externalId)).toEqual(["acme/#1", "acme/#2"]);
    expect(result.preview.alertsRequested).toEqual([
      "code-scanning",
      "secret-scanning",
      "dependabot",
    ]);
  });

  it("aggregates issues across the root repo and resolvable submodules", async () => {
    const config = baseConfig();
    config.layout = {
      type: "meta-repo",
      submodules: { backend: "apps/backend" },
    };
    fs.writeFileSync(
      path.join(tmpDir, ".gitmodules"),
      [
        '[submodule "backend"]',
        "  path = apps/backend",
        "  url = git@github.com:acme/backend.git",
      ].join("\n"),
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(config));
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      shape: "categorized-multi-list",
      categories: [
        {
          id: "Repository",
          items: [
            { externalId: "acme/demo", label: "acme/demo" },
            { externalId: "acme/backend", label: "acme/backend" },
          ],
        },
        { id: "Project", items: [] },
      ],
    });

    const result = await deriveGithubSources("demo");

    expect(
      (result.sources.Repository ?? []).map((e) => (typeof e === "object" ? e.externalId : e)),
    ).toEqual(["acme/demo", "acme/backend"]);
  });

  it("includes an unmatched-but-accessible repo (missing from the capped/paginated listing)", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(baseConfig()));
    // listSourceCandidates omits acme/demo (e.g. beyond the 100-repo page), but a
    // direct probe confirms the user can access it, so it is included anyway.
    vi.mocked(pluginManager.invoke).mockImplementation(
      async (_pluginId: string, method: string) => {
        if (method === "probeRepoAccess") return { accessible: true };
        return {
          shape: "categorized-multi-list",
          categories: [
            { id: "Repository", items: [{ externalId: "acme/other", label: "acme/other" }] },
            { id: "Project", items: [] },
          ],
        };
      },
    );

    const result = await deriveGithubSources("demo");

    expect(result.preview.repos).toEqual(["acme/demo"]);
    expect(result.preview.alertsRequested).toEqual([
      "code-scanning",
      "secret-scanning",
      "dependabot",
    ]);
  });

  it("throws ORG_APPROVAL_REQUIRED when the only repo is blocked by org OAuth App restrictions", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(baseConfig()));
    vi.mocked(pluginManager.invoke).mockImplementation(
      async (_pluginId: string, method: string) => {
        if (method === "probeRepoAccess") {
          return {
            accessible: false,
            status: 403,
            message:
              "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.",
          };
        }
        return {
          shape: "categorized-multi-list",
          categories: [
            { id: "Repository", items: [] },
            { id: "Project", items: [] },
          ],
        };
      },
    );

    await expect(deriveGithubSources("demo")).rejects.toMatchObject({
      code: "ORG_APPROVAL_REQUIRED",
      statusCode: 403,
      params: { owner: "acme" },
    });
  });
});

describe("deriveAndPersistGithubSources", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, ".roubo"), { recursive: true });
  });

  it("writes the derived sources into roubo.yaml on success", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(baseConfig()));
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      shape: "categorized-multi-list",
      categories: [
        { id: "Repository", items: [{ externalId: "acme/demo", label: "acme/demo" }] },
        { id: "Project", items: [{ externalId: "acme/#1", label: "Planning" }] },
      ],
    });

    const preview = await deriveAndPersistGithubSources("demo");

    expect(preview).not.toBeNull();
    expect(preview?.repos).toEqual(["acme/demo"]);
    const written = fs.readFileSync(path.join(tmpDir, ".roubo", "roubo.yaml"), "utf-8");
    expect(written).toContain("sources:");
    expect(written).toContain("acme/demo");
    expect(written).toContain("acme/#1");
  });

  it("swallows derivation errors and still returns null without writing", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(projectFor(baseConfig()));
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("plugin offline"));

    const preview = await deriveAndPersistGithubSources("demo");

    expect(preview).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, ".roubo", "roubo.yaml"))).toBe(false);
  });
});
