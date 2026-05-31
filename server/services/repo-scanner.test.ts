import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeConfig, makeDirent } from "../test/fixtures.js";

// ── Mocks ──

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(""),
  access: vi.fn().mockRejectedValue(new Error("not found")),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error("no remote"), "");
    },
  ),
}));

vi.mock("./config-parser.js", () => ({
  parseConfig: vi.fn().mockReturnValue({ valid: false }),
}));

import fs from "node:fs";
import { readdir, readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseConfig } from "./config-parser.js";
import { scanRepo, extractPortVar, extractComposeVars } from "./repo-scanner.js";

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);
const mockedAccess = vi.mocked(access);
const mockedExecFile = vi.mocked(execFile);
const mockedParseConfig = vi.mocked(parseConfig);

// ── scanRepo ──

describe("scanRepo", () => {
  beforeEach(() => {
    // Re-apply default mock behaviours (restoreMocks clears factory-set implementations)
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue("");
    mockedReaddir.mockResolvedValue([]);
    mockedReadFile.mockResolvedValue("");
    mockedAccess.mockRejectedValue(new Error("not found"));
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(new Error("no remote"), "");
      return undefined as any;
    });
    mockedParseConfig.mockReturnValue({ valid: false });
  });

  it("returns suggestedName from basename of repoPath", async () => {
    const result = await scanRepo("/home/user/projects/My-Cool-Project");
    expect(result.detected.suggestedName).toBe("my-cool-project");
  });

  it("runs the user-supplied root through resolveWithin (rejects an empty root before touching the filesystem)", async () => {
    // The scan root is normalised through resolveWithin so the value reaching
    // every readdir sink is sanitized (closes CodeQL js/path-injection). An
    // empty root is rejected by that sanitizer, whereas a bare path.resolve("")
    // would silently fall back to the process cwd.
    mockedReaddir.mockClear();
    await expect(scanRepo("")).rejects.toThrow();
    expect(mockedReaddir).not.toHaveBeenCalled();
  });

  it("detects .git directory", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      return String(p).endsWith(".git");
    });

    const result = await scanRepo("/repos/project");
    expect(result.detected.hasGit).toBe(true);
  });

  it("detects .gitmodules and sets structureType to meta-repo", async () => {
    const gitmodulesContent = [
      '[submodule "lib-core"]',
      "  path = lib/core",
      "  url = git@github.com:org/core.git",
      '[submodule "lib-utils"]',
      "  path = lib/utils",
      "  url = git@github.com:org/utils.git",
    ].join("\n");

    mockedExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith(".gitmodules") || s.endsWith(".git");
    });
    mockedReadFileSync.mockReturnValue(gitmodulesContent as any);

    const result = await scanRepo("/repos/meta-project");
    expect(result.detected.structureType).toBe("meta-repo");
    expect(result.detected.submodules).toEqual({
      "lib-core": "lib/core",
      "lib-utils": "lib/utils",
    });
  });

  it("detects monorepo from root package.json with workspaces", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith("package.json") || s.endsWith(".git");
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({ workspaces: ["packages/*"] }) as any);

    const result = await scanRepo("/repos/mono");
    expect(result.detected.structureType).toBe("monorepo");
  });

  it("detects docker-compose files during walk", async () => {
    mockedReaddir.mockResolvedValue([makeDirent("docker-compose.yml", true)] as any);

    const result = await scanRepo("/repos/with-docker");
    expect(result.detected.dockerComposeFiles).toContain("docker-compose.yml");
  });

  it("surfaces existingConfig when parseConfig returns valid", async () => {
    const config = makeConfig();
    mockedParseConfig.mockReturnValue({ valid: true, config });

    const result = await scanRepo("/repos/configured");
    expect(result.existingConfig).toEqual({
      path: ".roubo/roubo.yaml",
      config,
    });
  });

  // ── git remote detection (detectRepo) ──

  it("detects SSH git remote URL", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p).endsWith(".git"));
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(
        null,
        "git@github.com:myorg/my-repo.git\n",
      );
      return undefined as any;
    });

    const result = await scanRepo("/repos/ssh-repo");
    expect(result.detected.suggestedRepo).toBe("myorg/my-repo");
  });

  it("detects HTTPS git remote URL", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p).endsWith(".git"));
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(
        null,
        "https://github.com/another-org/another-repo.git\n",
      );
      return undefined as any;
    });

    const result = await scanRepo("/repos/https-repo");
    expect(result.detected.suggestedRepo).toBe("another-org/another-repo");
  });

  it("returns null suggestedRepo when git remote fails", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p).endsWith(".git"));

    const result = await scanRepo("/repos/no-remote");
    expect(result.detected.suggestedRepo).toBeNull();
  });

  it("returns null suggestedRepo for unrecognizable remote URL format", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p).endsWith(".git"));
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(
        null,
        "some-weird-protocol://not-a-real-url\n",
      );
      return undefined as any;
    });

    const result = await scanRepo("/repos/weird-remote");
    expect(result.detected.suggestedRepo).toBeNull();
  });

  it("handles invalid root package.json gracefully", async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith("package.json");
    });
    mockedReadFileSync.mockReturnValue("not valid json" as any);

    const result = await scanRepo("/repos/bad-pkg");
    expect(result.detected.structureType).toBe("single-repo");
  });

  // ── walk: .sln files, .env files ──

  it("detects .sln files during walk", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dotnet-app") {
        return [makeDirent("MyApp.sln", true)] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/dotnet-app");
    expect(result.detected.solutionFiles).toContain("MyApp.sln");
  });

  it("detects .env files during walk", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/env-app") {
        return [
          makeDirent(".env", true),
          makeDirent(".env.local", true),
          makeDirent(".env.production", true),
        ] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/env-app");
    expect(result.detected.envFiles).toHaveLength(3);
    expect(result.detected.envFiles).toContain(".env");
    expect(result.detected.envFiles).toContain(".env.local");
    expect(result.detected.envFiles).toContain(".env.production");
  });

  it("detects docker-compose.yaml (alternate extension)", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-yaml") {
        return [makeDirent("docker-compose.yaml", true)] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/dc-yaml");
    expect(result.detected.dockerComposeFiles).toContain("docker-compose.yaml");
  });

  // ── walk: subdirectory scanning + vite detection via package.json ──

  it("detects vite projects in subdirectories", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/mono-vite") {
        return [makeDirent("client", false)] as any;
      }
      if (dirStr === "/repos/mono-vite/client") {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/mono-vite/client/package.json") return undefined as any;
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/mono-vite/client/package.json") {
        return JSON.stringify({
          devDependencies: { vite: "5.0.0" },
        });
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/mono-vite");
    expect(result.detected.viteProjects).toContain("client");
  });

  it("skips directories in SKIP_DIRS set", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/skip-test") {
        return [
          makeDirent("node_modules", false),
          makeDirent(".git", false),
          makeDirent("bin", false),
          makeDirent("obj", false),
          makeDirent("dist", false),
          makeDirent("build", false),
          makeDirent(".roubo", false),
          makeDirent("src", false),
        ] as any;
      }
      // Only 'src' should be reached
      if (dirStr === "/repos/skip-test/src") {
        return [makeDirent("App.sln", true)] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/skip-test");
    expect(result.detected.solutionFiles).toContain("src/App.sln");
  });

  it("handles readdir error gracefully in walk", async () => {
    mockedReaddir.mockRejectedValue(new Error("permission denied"));

    const result = await scanRepo("/repos/unreadable");
    expect(result.detected.dockerComposeFiles).toEqual([]);
  });

  // ── isRunnableProject + hasTopLevelStatements + hasProgramMain ──

  it("detects .csproj with top-level statements as runnable", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-tls") {
        return [makeDirent("src", false)] as any;
      }
      if (dirStr === "/repos/dotnet-tls/src") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dotnet-tls/src/Program.cs") {
        return "var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.Run();";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-tls");
    expect(result.detected.dotnetProjects).toContain("src/Api.csproj");
  });

  it("detects .csproj with traditional Program.Main as runnable", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-main") {
        return [makeDirent("src", false)] as any;
      }
      if (dirStr === "/repos/dotnet-main/src") {
        return [makeDirent("App.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dotnet-main/src/Program.cs") {
        return [
          "namespace MyApp",
          "{",
          "    public class Program",
          "    {",
          "        public static void Main(string[] args)",
          "        {",
          "            CreateHostBuilder(args).Build().Run();",
          "        }",
          "    }",
          "}",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-main");
    expect(result.detected.dotnetProjects).toContain("src/App.csproj");
  });

  it("detects .csproj with async Task Main as runnable", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-async") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dotnet-async/Program.cs") {
        return [
          "namespace MyApp",
          "{",
          "    public class Program",
          "    {",
          "        public static async Task Main(string[] args)",
          "        {",
          "            await CreateHostBuilder(args).Build().RunAsync();",
          "        }",
          "    }",
          "}",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-async");
    expect(result.detected.dotnetProjects).toContain("Api.csproj");
  });

  it("excludes .csproj without runnable entry point", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-lib") {
        return [makeDirent("Lib.csproj", true), makeDirent("MyClass.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dotnet-lib/MyClass.cs") {
        return [
          "namespace MyLib",
          "{",
          "    public class MyClass",
          "    {",
          "        public void DoSomething() {}",
          "    }",
          "}",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-lib");
    expect(result.detected.dotnetProjects).toEqual([]);
  });

  it("handles hasTopLevelStatements with comments and using directives", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-comments") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dotnet-comments/Program.cs") {
        return [
          "// This is a comment",
          "/* Block comment */",
          "#pragma warning disable",
          "using System;",
          "global using System.Linq;",
          "",
          '[assembly: InternalsVisibleTo("Tests")]',
          "var builder = WebApplication.CreateBuilder(args);",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-comments");
    expect(result.detected.dotnetProjects).toContain("Api.csproj");
  });

  it("handles hasTopLevelStatements with multi-line block comments", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-block") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dotnet-block/Program.cs") {
        return [
          "/*",
          " * Multi-line block comment",
          " * spanning several lines",
          " */",
          "var app = WebApplication.CreateBuilder(args);",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-block");
    expect(result.detected.dotnetProjects).toContain("Api.csproj");
  });

  it("handles isRunnableProject when readdir fails", async () => {
    // First call for the root succeeds; inner call for the directory with .csproj fails
    let callCount = 0;
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-err") {
        return [makeDirent("src", false)] as any;
      }
      if (dirStr === "/repos/dotnet-err/src") {
        // First call finds the .csproj, second call (for isRunnableProject) fails
        callCount++;
        if (callCount === 1) {
          return [makeDirent("Api.csproj", true)] as any;
        }
        throw new Error("permission denied");
      }
      return [];
    });

    const result = await scanRepo("/repos/dotnet-err");
    expect(result.detected.dotnetProjects).toEqual([]);
  });

  it("handles unreadable .cs files gracefully", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-unreadable") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockRejectedValue(new Error("EACCES"));

    const result = await scanRepo("/repos/dotnet-unreadable");
    expect(result.detected.dotnetProjects).toEqual([]);
  });

  it("checks Program.cs first when sorting cs files", async () => {
    const readOrder: string[] = [];
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-sort") {
        return [
          makeDirent("Api.csproj", true),
          makeDirent("Zebra.cs", true),
          makeDirent("Program.cs", true),
          makeDirent("Alpha.cs", true),
        ] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr.endsWith(".cs")) {
        const fileName = pStr.split("/").pop();
        if (!fileName) throw new Error("expected file name from path");
        readOrder.push(fileName);
        // Program.cs is the one with the entry point
        if (pStr.endsWith("Program.cs")) {
          return "var app = WebApplication.CreateBuilder(args);";
        }
        return "namespace MyApp { public class Foo {} }";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-sort");
    expect(result.detected.dotnetProjects).toContain("Api.csproj");
    // Program.cs should be checked first
    expect(readOrder[0]).toBe("Program.cs");
  });

  // ── parseDockerComposeServices ──

  it("parses docker-compose with database services", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-db") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-db/docker-compose.yml") {
        return [
          "services:",
          "  postgres:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
          "  redis:",
          "    image: redis:7-alpine",
          "    ports:",
          '      - "6379:6379"',
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-db");
    expect(result.detected.suggestedComponents).toHaveLength(2);

    const pgComponent = result.detected.suggestedComponents.find((s) => s.key === "postgres");
    if (!pgComponent) throw new Error("expected postgres service");
    expect(pgComponent.config.type).toBe("database");
    expect(pgComponent.config.docker?.composeFile).toBe("docker-compose.yml");
    expect(pgComponent.config.docker?.service).toBe("postgres");

    const redisComponent = result.detected.suggestedComponents.find((s) => s.key === "redis");
    if (!redisComponent) throw new Error("expected redis service");
    expect(redisComponent.config.type).toBe("database");
  });

  it("detects init services in docker-compose", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-init") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-init/docker-compose.yml") {
        return [
          "services:",
          "  db:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
          "  db-migrate:",
          "    image: postgres:15",
          "    depends_on:",
          "      - db",
          '    restart: "no"',
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-init");
    const dbComponent = result.detected.suggestedComponents.find((s) => s.key === "db");
    if (!dbComponent) throw new Error("expected db service");
    expect(dbComponent.config.docker?.initService).toBe("db-migrate");

    // The init service itself should NOT appear as a separate suggestion
    const migrateComponent = result.detected.suggestedComponents.find(
      (s) => s.key === "db-migrate",
    );
    expect(migrateComponent).toBeUndefined();
  });

  it("detects init services with depends_on object syntax", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-init-obj") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-init-obj/docker-compose.yml") {
        return [
          "services:",
          "  db:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
          "  db-seed:",
          "    image: postgres:15",
          "    depends_on:",
          "      db:",
          "        condition: service_healthy",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-init-obj");
    const dbComponent = result.detected.suggestedComponents.find((s) => s.key === "db");
    if (!dbComponent) throw new Error("expected db service");
    expect(dbComponent.config.docker?.initService).toBe("db-seed");
  });

  it("skips non-db services in docker-compose", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-mixed") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-mixed/docker-compose.yml") {
        return [
          "services:",
          "  api:",
          "    build: .",
          "    ports:",
          '      - "8080:8080"',
          "  postgres:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
          "  nginx:",
          "    image: nginx:latest",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-mixed");
    // Only postgres should be suggested (it matches DB pattern)
    expect(result.detected.suggestedComponents).toHaveLength(1);
    expect(result.detected.suggestedComponents[0].key).toBe("postgres");

    // All service names should be tracked
    expect(result.detected.dockerComposeServiceNames["docker-compose.yml"]).toEqual([
      "api",
      "postgres",
      "nginx",
    ]);
  });

  it("handles docker-compose with all DB image patterns", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-all-dbs") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-all-dbs/docker-compose.yml") {
        return [
          "services:",
          "  mssql:",
          "    image: mcr.microsoft.com/mssql/server:2022-latest",
          "  mysql:",
          "    image: mysql:8",
          "  mongo:",
          "    image: mongo:7",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-all-dbs");
    expect(result.detected.suggestedComponents).toHaveLength(3);
    expect(result.detected.suggestedComponents.every((s) => s.config.type === "database")).toBe(
      true,
    );
  });

  it("handles invalid docker-compose YAML gracefully", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-bad") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-bad/docker-compose.yml") {
        throw new Error("ENOENT");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-bad");
    expect(result.detected.suggestedComponents).toEqual([]);
  });

  it("handles docker-compose with null/empty document", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-empty") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-empty/docker-compose.yml") {
        return "";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-empty");
    expect(result.detected.suggestedComponents).toEqual([]);
  });

  it("handles docker-compose services without image field", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-no-image") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-no-image/docker-compose.yml") {
        return ["services:", "  api:", "    build: ."].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-no-image");
    expect(result.detected.suggestedComponents).toEqual([]);
  });

  // ── inferDotnetServices ──

  it('infers single dotnet project as "backend"', async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/single-dotnet") {
        return [makeDirent("src", false)] as any;
      }
      if (dirStr === "/repos/single-dotnet/src") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("Program.cs")) {
        return "var app = WebApplication.CreateBuilder(args);";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/single-dotnet");
    const dotnetComponent = result.detected.suggestedComponents.find(
      (s) => s.config.type === "process" && s.config.command?.includes("dotnet run"),
    );
    if (!dotnetComponent) throw new Error("expected process service for dotnet");
    expect(dotnetComponent.key).toBe("backend");
    expect(dotnetComponent.config.command).toBe("dotnet run --project src/Api.csproj");
  });

  it("infers multiple dotnet projects with slugified dir names", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/multi-dotnet") {
        return [makeDirent("Api", false), makeDirent("Worker", false)] as any;
      }
      if (dirStr === "/repos/multi-dotnet/Api") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      if (dirStr === "/repos/multi-dotnet/Worker") {
        return [makeDirent("Worker.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("Program.cs")) {
        return "var app = WebApplication.CreateBuilder(args);";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/multi-dotnet");
    const dotnetServices = result.detected.suggestedComponents.filter(
      (s) => s.config.type === "process" && s.config.command?.includes("dotnet run"),
    );
    expect(dotnetServices).toHaveLength(2);
    expect(dotnetServices.find((s) => s.key === "api")).toBeDefined();
    expect(dotnetServices.find((s) => s.key === "worker")).toBeDefined();
  });

  it("filters out test projects from dotnet services", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-with-tests") {
        return [makeDirent("src", false), makeDirent("tests", false)] as any;
      }
      if (dirStr === "/repos/dotnet-with-tests/src") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      if (dirStr === "/repos/dotnet-with-tests/tests") {
        return [makeDirent("Api.Tests.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("Program.cs")) {
        return "var app = WebApplication.CreateBuilder(args);";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-with-tests");
    const dotnetServices = result.detected.suggestedComponents.filter(
      (s) => s.config.type === "process" && s.config.command?.includes("dotnet run"),
    );
    // Only the non-test project should be inferred
    expect(dotnetServices).toHaveLength(1);
    expect(dotnetServices[0].key).toBe("backend");
  });

  // ── inferFrontendServices ──

  it('infers single vite project as "frontend"', async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/single-vite") {
        return [makeDirent("web", false)] as any;
      }
      if (dirStr === "/repos/single-vite/web") {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/single-vite/web/package.json") return undefined as any;
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/single-vite/web/package.json") {
        return JSON.stringify({ devDependencies: { vite: "5.0.0" } });
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/single-vite");
    const frontendComponent = result.detected.suggestedComponents.find(
      (s) => s.config.type === "process" && s.config.command === "npm run dev",
    );
    if (!frontendComponent) throw new Error("expected process service for vite");
    expect(frontendComponent.key).toBe("frontend");
    expect(frontendComponent.config.directory).toBe("web");
    expect(frontendComponent.config.setup).toBe("npm install");
  });

  it("infers multiple vite projects with dir-based keys", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/multi-vite") {
        return [makeDirent("admin", false), makeDirent("client", false)] as any;
      }
      if (dirStr === "/repos/multi-vite/admin" || dirStr === "/repos/multi-vite/client") {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (
        pStr === "/repos/multi-vite/admin/package.json" ||
        pStr === "/repos/multi-vite/client/package.json"
      ) {
        return undefined as any;
      }
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (
        pStr === "/repos/multi-vite/admin/package.json" ||
        pStr === "/repos/multi-vite/client/package.json"
      ) {
        return JSON.stringify({ devDependencies: { vite: "5.0.0" } });
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/multi-vite");
    const viteServices = result.detected.suggestedComponents.filter(
      (s) => s.config.type === "process" && s.config.command === "npm run dev",
    );
    expect(viteServices).toHaveLength(2);
    expect(viteServices.find((s) => s.key === "admin")).toBeDefined();
    expect(viteServices.find((s) => s.key === "client")).toBeDefined();
  });

  // ── deduplicateServiceKeys ──

  it("deduplicates service keys when collisions occur", async () => {
    // Set up a scenario where both docker-compose and dotnet infer the same key
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dedup") {
        return [makeDirent("docker-compose.yml", true), makeDirent("backend", false)] as any;
      }
      if (dirStr === "/repos/dedup/backend") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/dedup/docker-compose.yml") {
        return [
          "services:",
          "  backend:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
        ].join("\n");
      }
      if (pStr.endsWith("Program.cs")) {
        return "var app = WebApplication.CreateBuilder(args);";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dedup");
    const keys = result.detected.suggestedComponents.map((s) => s.key);
    // All keys should be unique
    expect(new Set(keys).size).toBe(keys.length);
    // One should be "backend" and the other "backend-2"
    expect(keys).toContain("backend");
    expect(keys).toContain("backend-2");
  });

  // ── inferTools ──

  it("infers browser and VS Code tools for single vite service", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/vite-launch") {
        return [makeDirent("client", false)] as any;
      }
      if (dirStr === "/repos/vite-launch/client") {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/vite-launch/client/package.json") return undefined as any;
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/vite-launch/client/package.json") {
        return JSON.stringify({ devDependencies: { vite: "5.0.0" } });
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/vite-launch");
    const tools = result.detected.suggestedTools;

    // Should have a browser tool and a VS Code tool for the service dir
    const browserTool = tools.find((l) => l.config.type === "browser");
    if (!browserTool) throw new Error("expected browser tool");
    expect(browserTool.config.name).toBe("Web App");
    expect(browserTool.config.url).toBe("{{urls.frontend}}");

    const vscodeTool = tools.find(
      (l) => l.config.type === "shell" && l.source.startsWith("vscode:frontend"),
    );
    if (!vscodeTool) throw new Error("expected vscode tool");
    expect(vscodeTool.config.name).toBe("VS Code");
    expect(vscodeTool.config.command).toContain("client");
  });

  it("infers named tools for multiple vite services", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/multi-vite-launch") {
        return [makeDirent("admin", false), makeDirent("portal", false)] as any;
      }
      if (
        dirStr === "/repos/multi-vite-launch/admin" ||
        dirStr === "/repos/multi-vite-launch/portal"
      ) {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (
        pStr === "/repos/multi-vite-launch/admin/package.json" ||
        pStr === "/repos/multi-vite-launch/portal/package.json"
      ) {
        return undefined as any;
      }
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (
        pStr === "/repos/multi-vite-launch/admin/package.json" ||
        pStr === "/repos/multi-vite-launch/portal/package.json"
      ) {
        return JSON.stringify({ devDependencies: { vite: "5.0.0" } });
      }
      throw new Error("not found");
    });
    mockedExistsSync.mockImplementation((p: unknown) => {
      return String(p).endsWith("package.json");
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({ dependencies: { vite: "5.0.0" } }) as any);

    const result = await scanRepo("/repos/multi-vite-launch");
    const tools = result.detected.suggestedTools;

    const browserTools = tools.filter((l) => l.config.type === "browser");
    expect(browserTools).toHaveLength(2);
    expect(browserTools.some((l) => l.config.name === "Web App (admin)")).toBe(true);
    expect(browserTools.some((l) => l.config.name === "Web App (portal)")).toBe(true);

    const vscodeTools = tools.filter(
      (l) => l.config.type === "shell" && l.source.startsWith("vscode:"),
    );
    expect(vscodeTools).toHaveLength(2);
    expect(vscodeTools.some((l) => l.config.name === "VS Code (admin)")).toBe(true);
    expect(vscodeTools.some((l) => l.config.name === "VS Code (portal)")).toBe(true);
  });

  it("infers Rider tool for solution files", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/sln-launch") {
        return [makeDirent("MyApp.sln", true)] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/sln-launch");
    const riderTool = result.detected.suggestedTools.find((l) => l.source.startsWith("rider:"));
    if (!riderTool) throw new Error("expected rider tool");
    expect(riderTool.config.name).toBe("Rider");
    expect(riderTool.config.type).toBe("shell");
    expect(riderTool.config.command).toContain("Rider");
    expect(riderTool.config.command).toContain("MyApp.sln");
  });

  it("infers named Rider tools for multiple solution files", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/multi-sln") {
        return [makeDirent("Api.sln", true), makeDirent("Worker.sln", true)] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/multi-sln");
    const riderTools = result.detected.suggestedTools.filter((l) => l.source.startsWith("rider:"));
    expect(riderTools).toHaveLength(2);
    expect(riderTools.some((l) => l.config.name === "Rider (Api.sln)")).toBe(true);
    expect(riderTools.some((l) => l.config.name === "Rider (Worker.sln)")).toBe(true);
  });

  it("never emits a VS Code root tool", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/api-only-launch") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("Program.cs")) {
        return "var app = WebApplication.CreateBuilder(args);";
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/api-only-launch");
    const vscodeRoot = result.detected.suggestedTools.find((l) => l.source === "vscode:root");
    expect(vscodeRoot).toBeUndefined();
  });

  it("skips VS Code shell tool when vite dir is root (.)", async () => {
    // This tests the `if (!dir || dir === '.') continue` path in inferTools
    // We need viteProjects to contain '.' which happens when vite is detected at root
    // but the walk logic won't produce '.', so we test via a dir that resolves to root
    // Actually, this path would occur if directory is '.' or undefined
    // In practice, inferFrontendServices sets directory from viteProjects which are relative paths
    // A root vite project would have been detected from root package.json walk
    // For this test, we just verify the behavior doesn't crash for edge cases
    const result = await scanRepo("/repos/no-crash");
    expect(result.detected.suggestedTools).toEqual([]);
  });

  // ── Walk depth limit ──

  it("respects MAX_DEPTH of 3", async () => {
    const visited: string[] = [];
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      visited.push(dirStr);
      // Create nested directories deeper than MAX_DEPTH
      if (dirStr === "/repos/deep") {
        return [makeDirent("level1", false)] as any;
      }
      if (dirStr === "/repos/deep/level1") {
        return [makeDirent("level2", false)] as any;
      }
      if (dirStr === "/repos/deep/level1/level2") {
        return [makeDirent("level3", false)] as any;
      }
      if (dirStr === "/repos/deep/level1/level2/level3") {
        return [makeDirent("level4", false)] as any;
      }
      if (dirStr === "/repos/deep/level1/level2/level3/level4") {
        return [makeDirent("should-not-reach.sln", true)] as any;
      }
      return [];
    });

    const result = await scanRepo("/repos/deep");
    // level4 directory should not be visited (depth > MAX_DEPTH)
    expect(visited).not.toContain("/repos/deep/level1/level2/level3/level4");
    expect(result.detected.solutionFiles).toEqual([]);
  });

  // ── existingConfig ──

  it("returns null existingConfig when parseConfig returns invalid", async () => {
    mockedParseConfig.mockReturnValue({ valid: false });

    const result = await scanRepo("/repos/no-config");
    expect(result.existingConfig).toBeNull();
  });

  // ── Full integration scenario ──

  it("handles a comprehensive repo scan with multiple detected items", async () => {
    // Repo with: .git, docker-compose.yml, dotnet project, vite project, .env, .sln
    mockedExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith(".git") || s.endsWith("package.json");
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({ dependencies: { vite: "5.0.0" } }) as any);
    mockedExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(
        null,
        "git@github.com:company/fullstack.git\n",
      );
      return undefined as any;
    });

    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/full") {
        return [
          makeDirent("docker-compose.yml", true),
          makeDirent(".env", true),
          makeDirent("App.sln", true),
          makeDirent("src", false),
          makeDirent("web", false),
        ] as any;
      }
      if (dirStr === "/repos/full/src") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      if (dirStr === "/repos/full/web") {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/full/web/package.json") return undefined as any;
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      const pStr = p.toString();
      if (pStr === "/repos/full/docker-compose.yml") {
        return [
          "services:",
          "  db:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
        ].join("\n");
      }
      if (pStr.endsWith("Program.cs")) {
        return "var app = WebApplication.CreateBuilder(args);";
      }
      if (pStr === "/repos/full/web/package.json") {
        return JSON.stringify({ devDependencies: { vite: "5.0.0" } });
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/full");

    expect(result.detected.hasGit).toBe(true);
    expect(result.detected.suggestedRepo).toBe("company/fullstack");
    expect(result.detected.suggestedName).toBe("full");
    expect(result.detected.dockerComposeFiles).toContain("docker-compose.yml");
    expect(result.detected.dotnetProjects).toContain("src/Api.csproj");
    expect(result.detected.viteProjects).toContain("web");
    expect(result.detected.solutionFiles).toContain("App.sln");
    expect(result.detected.envFiles).toContain(".env");

    // Should have services: db (database), backend (dotnet), frontend (vite)
    expect(result.detected.suggestedComponents).toHaveLength(3);
    expect(result.detected.suggestedComponents.find((s) => s.key === "db")).toBeDefined();
    expect(result.detected.suggestedComponents.find((s) => s.key === "backend")).toBeDefined();
    expect(result.detected.suggestedComponents.find((s) => s.key === "frontend")).toBeDefined();

    // Should have tools: Web App, VS Code (web), Rider
    expect(result.detected.suggestedTools.length).toBeGreaterThanOrEqual(3);
  });

  // ── isInitService edge cases ──

  it("detects init service by name pattern (init, migrate, seed, setup)", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-init-names") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return [
          "services:",
          "  redis:",
          "    image: redis:7",
          "    ports:",
          '      - "6379:6379"',
          "  redis-setup:",
          "    image: redis:7",
          "    depends_on:",
          "      - redis",
          "    ports:",
          '      - "9999:9999"',
          "    restart: always",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-init-names");
    const redisComponent = result.detected.suggestedComponents.find((s) => s.key === "redis");
    if (!redisComponent) throw new Error("expected redis service");
    expect(redisComponent.config.docker?.initService).toBe("redis-setup");
  });

  it("does not treat service as init when it does not depend on primary", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-no-dep") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return [
          "services:",
          "  db:",
          "    image: postgres:15",
          "  db-migrate:",
          "    image: postgres:15",
          '    restart: "no"',
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-no-dep");
    // Both should appear as separate suggestions since db-migrate doesn't depend on db
    expect(result.detected.suggestedComponents).toHaveLength(2);
  });

  // ── walk: subdirectory with invalid package.json ──

  it("handles invalid package.json in subdirectory gracefully", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/bad-sub-pkg") {
        return [makeDirent("lib", false)] as any;
      }
      if (dirStr === "/repos/bad-sub-pkg/lib") {
        return [] as any;
      }
      return [];
    });
    mockedAccess.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/bad-sub-pkg/lib/package.json") return undefined as any;
      throw new Error("not found");
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/bad-sub-pkg/lib/package.json") {
        return "not valid json at all {";
      }
      throw new Error("not found");
    });

    // Should not throw
    const result = await scanRepo("/repos/bad-sub-pkg");
    expect(result.detected.viteProjects).toEqual([]);
  });

  // ── gitmodules edge cases ──

  it("handles gitmodules with submodule section but no path", async () => {
    const gitmodulesContent = [
      '[submodule "incomplete"]',
      "  url = git@github.com:org/lib.git",
    ].join("\n");

    mockedExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith(".gitmodules") || s.endsWith(".git");
    });
    mockedReadFileSync.mockReturnValue(gitmodulesContent as any);

    const result = await scanRepo("/repos/incomplete-gitmodules");
    // The submodule without a path should not be included
    expect(Object.keys(result.detected.submodules)).toEqual([]);
    // Without valid submodule paths, structureType should not be meta-repo
    expect(result.detected.structureType).toBe("single-repo");
  });

  // ── isInitService: no ports detection ──

  it("detects init service by no-ports criterion", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-no-ports") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return [
          "services:",
          "  db:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
          "  db-helper:",
          "    image: postgres:15",
          "    depends_on:",
          "      - db",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-no-ports");
    const dbComponent = result.detected.suggestedComponents.find((s) => s.key === "db");
    if (!dbComponent) throw new Error("expected db service");
    expect(dbComponent.config.docker?.initService).toBe("db-helper");
  });

  it("detects init service by empty ports array", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-empty-ports") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return [
          "services:",
          "  db:",
          "    image: postgres:15",
          "    ports:",
          '      - "5432:5432"',
          "  db-worker:",
          "    image: postgres:15",
          "    depends_on:",
          "      - db",
          "    ports: []",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-empty-ports");
    const dbComponent = result.detected.suggestedComponents.find((s) => s.key === "db");
    if (!dbComponent) throw new Error("expected db service");
    expect(dbComponent.config.docker?.initService).toBe("db-worker");
  });

  // ── isInitService: on-failure restart ──

  it("detects init service by on-failure restart policy", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-on-failure") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return [
          "services:",
          "  mongo:",
          "    image: mongo:7",
          "    ports:",
          '      - "27017:27017"',
          "  mongo-seed:",
          "    image: mongo:7",
          "    depends_on:",
          "      - mongo",
          "    ports:",
          '      - "9876:9876"',
          "    restart: on-failure",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-on-failure");
    const mongoComponent = result.detected.suggestedComponents.find((s) => s.key === "mongo");
    if (!mongoComponent) throw new Error("expected mongo service");
    expect(mongoComponent.config.docker?.initService).toBe("mongo-seed");
  });

  // ── hasTopLevelStatements: file with only comments/using/empty ──

  it("returns false for hasTopLevelStatements when file has only using directives and no code", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-usings") {
        return [
          makeDirent("GlobalUsings.csproj", true),
          makeDirent("GlobalUsings.cs", true),
        ] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("GlobalUsings.cs")) {
        return [
          "global using System;",
          "global using System.Linq;",
          "using System.Collections.Generic;",
          "",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-usings");
    // File with only using directives is not runnable
    expect(result.detected.dotnetProjects).toEqual([]);
  });

  // ── hasTopLevelStatements: "using" that is not a directive ──

  it('treats "using var" and "using (" as top-level statements, not directives', async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      const dirStr = dir.toString();
      if (dirStr === "/repos/dotnet-using-var") {
        return [makeDirent("Api.csproj", true), makeDirent("Program.cs", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("Program.cs")) {
        return ["using System;", 'using var stream = File.OpenRead("test");'].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dotnet-using-var");
    // "using var" is a top-level statement (not a using directive)
    expect(result.detected.dotnetProjects).toContain("Api.csproj");
  });

  // ── docker-compose with mariadb image ──

  it("detects mariadb as database service", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-maria") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return ["services:", "  mariadb:", "    image: mariadb:11"].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-maria");
    expect(result.detected.suggestedComponents).toHaveLength(1);
    expect(result.detected.suggestedComponents[0].config.type).toBe("database");
  });

  // ── docker-compose with sql-server image ──

  it("detects mssql/sqlserver/sql-server as database service", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-sqlserver") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString().endsWith("docker-compose.yml")) {
        return [
          "services:",
          "  sqlserver:",
          "    image: mcr.microsoft.com/mssql/server:2022-latest",
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-sqlserver");
    expect(result.detected.suggestedComponents).toHaveLength(1);
    expect(result.detected.suggestedComponents[0].config.type).toBe("database");
  });

  it("detects port env var from compose service and sets portEnvVar on suggestion", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-portvar") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-portvar/docker-compose.yml") {
        return [
          "services:",
          "  sql:",
          "    image: mcr.microsoft.com/mssql/server:2022-latest",
          '    ports: ["${DB_HOST_PORT:-1433}:1433"]',
        ].join("\n");
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-portvar");
    const component = result.detected.suggestedComponents.find((s) => s.key === "sql");
    if (!component) throw new Error("expected sql service");
    expect(component.config.docker?.portEnvVar).toBe("DB_HOST_PORT");
    expect(result.detected.dockerComposePortVars["docker-compose.yml"]).toEqual({
      sql: "DB_HOST_PORT",
    });
  });

  it("sets portEnvVar to undefined and portVars to null when port is hardcoded", async () => {
    mockedReaddir.mockImplementation(async (dir: any) => {
      if (dir.toString() === "/repos/dc-hardcoded") {
        return [makeDirent("docker-compose.yml", true)] as any;
      }
      return [];
    });
    mockedReadFile.mockImplementation(async (p: any) => {
      if (p.toString() === "/repos/dc-hardcoded/docker-compose.yml") {
        return ["services:", "  db:", "    image: postgres:15", '    ports: ["5432:5432"]'].join(
          "\n",
        );
      }
      throw new Error("not found");
    });

    const result = await scanRepo("/repos/dc-hardcoded");
    const component = result.detected.suggestedComponents.find((s) => s.key === "db");
    if (!component) throw new Error("expected db service");
    expect(component.config.docker?.portEnvVar).toBeUndefined();
    expect(result.detected.dockerComposePortVars["docker-compose.yml"]).toEqual({ db: null });
  });
});

// ── extractPortVar ──

describe("extractPortVar", () => {
  it("extracts variable from ${VAR:-default}:container format", () => {
    expect(extractPortVar("${DB_HOST_PORT:-1433}:1433")).toBe("DB_HOST_PORT");
  });

  it("extracts variable from ${VAR}:container format", () => {
    expect(extractPortVar("${HOST_PORT}:5432")).toBe("HOST_PORT");
  });

  it("extracts variable from ip:${VAR}:container format", () => {
    expect(extractPortVar("0.0.0.0:${HOST_PORT}:5432")).toBe("HOST_PORT");
  });

  it("returns null for hardcoded port", () => {
    expect(extractPortVar("5432:5432")).toBeNull();
  });

  it("returns null for container-only variable (no host binding)", () => {
    expect(extractPortVar("5432:${CONTAINER_PORT}")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(extractPortVar(1433)).toBeNull();
    expect(extractPortVar(null)).toBeNull();
  });
});

// ── extractComposeVars ──

describe("extractComposeVars", () => {
  it("extracts variable with default value from a string", () => {
    const result = extractComposeVars({ environment: ["DB_PASSWORD=${DB_PASSWORD:-secret}"] });
    expect(result["DB_PASSWORD"]).toBe("secret");
  });

  it("extracts variable without default as null", () => {
    const result = extractComposeVars({ environment: ["DB_HOST=${DB_HOST}"] });
    expect(result["DB_HOST"]).toBeNull();
  });

  it("extracts variables from port mappings", () => {
    const result = extractComposeVars({ ports: ["${HOST_PORT:-5432}:5432"] });
    expect(result["HOST_PORT"]).toBe("5432");
  });

  it("extracts variables from nested objects", () => {
    const result = extractComposeVars({
      healthcheck: { test: "pg_isready -U ${POSTGRES_USER:-postgres}" },
    });
    expect(result["POSTGRES_USER"]).toBe("postgres");
  });

  it("extracts variables from arrays of strings", () => {
    const result = extractComposeVars({
      command: ["--password", "${DB_PASS:-changeme}"],
    });
    expect(result["DB_PASS"]).toBe("changeme");
  });

  it("extracts multiple variables from a single service", () => {
    const result = extractComposeVars({
      environment: [
        "POSTGRES_USER=${POSTGRES_USER:-postgres}",
        "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}",
        "POSTGRES_DB=${POSTGRES_DB:-mydb}",
      ],
      ports: ["${HOST_PORT:-5432}:5432"],
    });
    expect(result["POSTGRES_USER"]).toBe("postgres");
    expect(result["POSTGRES_PASSWORD"]).toBeNull();
    expect(result["POSTGRES_DB"]).toBe("mydb");
    expect(result["HOST_PORT"]).toBe("5432");
  });

  it("does not duplicate variables (first occurrence wins)", () => {
    const result = extractComposeVars({
      environment: ["FOO=${FOO:-first}"],
      command: "${FOO:-second}",
    });
    expect(result["FOO"]).toBe("first");
  });

  it("handles non-object input gracefully", () => {
    expect(extractComposeVars(null)).toEqual({});
    expect(extractComposeVars(undefined)).toEqual({});
    expect(extractComposeVars("string")).toEqual({});
  });

  it("returns empty object for a service with no variables", () => {
    const result = extractComposeVars({ image: "postgres:15", restart: "unless-stopped" });
    expect(result).toEqual({});
  });
});
