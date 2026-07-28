import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  INDEX_SOURCE,
  assembleRoutes,
  collectHandlers,
  collectIndexRegistrations,
  collectRoutes,
  compareCodeUnits,
  generate,
  joinRoutePath,
  listRouteModules,
  outPath,
  renderInventory,
  renderMarkdown,
  repoRoot,
} from "./generate-route-inventory.js";

const indexText = readFileSync(resolve(repoRoot, INDEX_SOURCE), "utf8");

describe("collectIndexRegistrations", () => {
  it("resolves every app.use router mount back to its module", () => {
    const { mounts } = collectIndexRegistrations(indexText);
    // Every `app.use("<prefix>", <ident>Router)` line in server/index.ts, found
    // textually, must also be in the parsed mount table. This is the guard
    // against the parser silently dropping a whole router.
    const textual = [...indexText.matchAll(/app\.use\(\s*"([^"]+)",\s*(\w+Router)\s*\)/g)];
    expect(textual.length).toBeGreaterThan(0);
    expect(mounts).toHaveLength(textual.length);
    for (const [, mountPath] of textual) {
      expect(mounts.some((mount) => mount.mountPath === mountPath)).toBe(true);
    }
    // Twelve routers share the /api/projects prefix, so the table must keep
    // duplicate prefixes rather than collapsing them.
    expect(mounts.filter((mount) => mount.mountPath === "/api/projects").length).toBeGreaterThan(1);
    expect(mounts.every((mount) => mount.source.startsWith("server/routes/"))).toBe(true);
  });

  it("captures handlers registered directly on app, not just mounted routers", () => {
    const { inlineRoutes } = collectIndexRegistrations(indexText);
    expect(inlineRoutes).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/api/benches", source: INDEX_SOURCE },
        // The SPA catch-all. Emitted rather than curated away: a hand-kept skip
        // list is the same drift the generated inventory removes.
        { method: "GET", path: "/{*path}", source: INDEX_SOURCE },
      ]),
    );
  });

  it("skips app.use middleware calls that mount no router", () => {
    const { mounts } = collectIndexRegistrations(
      ["app.use(cors());", "app.use(express.static(clientDist));"].join("\n"),
    );
    expect(mounts).toEqual([]);
  });

  it("throws when a router is mounted at a non-literal path", () => {
    const source = [
      'import benchesRouter from "./routes/benches.js";',
      "app.use(prefix, benchesRouter);",
    ].join("\n");
    expect(() => collectIndexRegistrations(source)).toThrow(/non-literal path/);
  });

  it("throws when a handler on app uses a non-literal path", () => {
    expect(() => collectIndexRegistrations("app.get(pattern, handler);")).toThrow(
      /non-literal path/,
    );
  });
});

describe("collectHandlers", () => {
  it("parses the multi-line router.get( form as well as the single-line form", () => {
    // 13 handlers in the tree wrap the path onto its own line, which is why the
    // extraction is an AST walk and not a line-based regex.
    const source = [
      'router.get("/single", handler);',
      "router.put(",
      '  "/multi/:id",',
      "  requireThing,",
      "  async (req, res) => {},",
      ");",
    ].join("\n");
    expect(collectHandlers(source, "server/routes/fixture.ts")).toEqual([
      { method: "GET", handlerPath: "/single" },
      { method: "PUT", handlerPath: "/multi/:id" },
    ]);
  });

  it("ignores router.use middleware, which carries no path", () => {
    expect(collectHandlers("router.use(rateLimiter);", "server/routes/fixture.ts")).toEqual([]);
  });

  it("throws with file and line when a handler path is not a literal", () => {
    const source = ['router.get("/ok", handler);', "router.post(buildPath(), handler);"].join("\n");
    expect(() => collectHandlers(source, "server/routes/fixture.ts")).toThrow(
      /server\/routes\/fixture\.ts:2: router\.post uses a non-literal path/,
    );
  });
});

describe("joinRoutePath", () => {
  it("collapses the root handler onto its mount prefix", () => {
    expect(joinRoutePath("/api/filesystem/browse", "/")).toBe("/api/filesystem/browse");
    expect(joinRoutePath("/api/settings", "/env-keys")).toBe("/api/settings/env-keys");
    expect(joinRoutePath("", "/api/benches")).toBe("/api/benches");
  });
});

describe("assembleRoutes", () => {
  const registrations = {
    mounts: [
      { mountPath: "/api/projects", source: "server/routes/a.ts" },
      { mountPath: "/api/legacy", source: "server/routes/a.ts" },
    ],
    inlineRoutes: [{ method: "GET", path: "/api/benches", source: INDEX_SOURCE }],
  };

  it("expands a router mounted more than once and sorts by path then method", () => {
    const routes = assembleRoutes(registrations, [
      {
        source: "server/routes/a.ts",
        handlers: [
          { method: "POST", handlerPath: "/:id" },
          { method: "GET", handlerPath: "/:id" },
        ],
      },
    ]);
    expect(routes).toEqual([
      { method: "GET", path: "/api/benches", source: INDEX_SOURCE },
      { method: "GET", path: "/api/legacy/:id", source: "server/routes/a.ts" },
      { method: "POST", path: "/api/legacy/:id", source: "server/routes/a.ts" },
      { method: "GET", path: "/api/projects/:id", source: "server/routes/a.ts" },
      { method: "POST", path: "/api/projects/:id", source: "server/routes/a.ts" },
    ]);
  });

  it("ignores helper modules that declare no handlers", () => {
    const routes = assembleRoutes(registrations, [
      { source: "server/routes/plugin-route-helpers.ts", handlers: [] },
    ]);
    expect(routes).toEqual(registrations.inlineRoutes);
  });

  it("throws when a router declares handlers but is never mounted", () => {
    expect(() =>
      assembleRoutes(registrations, [
        { source: "server/routes/orphan.ts", handlers: [{ method: "GET", handlerPath: "/x" }] },
      ]),
    ).toThrow(/server\/routes\/orphan\.ts declares 1 route handler\(s\) but is never mounted/);
  });

  it("orders by code unit, not by the runtime's locale collation", () => {
    // The drift gate only works if the generator is a pure function of the
    // source. localeCompare is not: under cs_CZ, Czech collation treats "ch"
    // as a single element sorting after "h", which puts check-config AFTER
    // github-projects and makes a Czech contributor's regeneration differ from
    // everyone else's. Both real paths, both really mounted at /api/projects.
    const routes = assembleRoutes({ mounts: registrations.mounts, inlineRoutes: [] }, [
      {
        source: "server/routes/a.ts",
        handlers: [
          { method: "GET", handlerPath: "/github-projects" },
          { method: "POST", handlerPath: "/check-config" },
        ],
      },
    ]);
    const projectPaths = routes
      .filter((route) => route.path.startsWith("/api/projects/"))
      .map((route) => route.path);
    expect(projectPaths).toEqual(["/api/projects/check-config", "/api/projects/github-projects"]);
    // Guard the helper itself, so a future edit cannot quietly reintroduce
    // locale sensitivity behind an unchanged-looking sort call.
    expect(compareCodeUnits("/api/projects/check-config", "/api/projects/github-projects")).toBe(
      -1,
    );
    expect(compareCodeUnits("/{*path}", "/api/benches")).toBe(1);
  });
});

describe("collectRoutes", () => {
  it("covers every mounted router and loses no handler", () => {
    const routes = collectRoutes();
    const { mounts, inlineRoutes } = collectIndexRegistrations(indexText);

    // Every mounted module contributes at least one route.
    for (const mount of mounts) {
      expect(routes.some((route) => route.source === mount.source)).toBe(true);
    }

    // The inventory size must equal the inline routes plus, for each mount, the
    // handler count of the module mounted there. A parser that silently drops a
    // handler fails here rather than shipping a short inventory.
    const handlerCounts = new Map(
      listRouteModules().map((source) => [
        source,
        collectHandlers(readFileSync(resolve(repoRoot, source), "utf8"), source).length,
      ]),
    );
    const expectedTotal =
      inlineRoutes.length +
      mounts.reduce((total, mount) => total + (handlerCounts.get(mount.source) ?? 0), 0);
    expect(routes).toHaveLength(expectedTotal);

    // The mounts named in #1018 as previously missing from the hand-kept list.
    for (const prefix of [
      "/api/marketplace",
      "/api/migration",
      "/api/hooks",
      "/api/settings",
      "/api/filesystem/browse",
      "/api/plugins",
      "/test",
    ]) {
      expect(routes.some((route) => route.path.startsWith(prefix))).toBe(true);
    }
  });
});

describe("renderMarkdown", () => {
  it("emits a do-not-edit banner and one table row per route", () => {
    const markdown = renderMarkdown([
      { method: "GET", path: "/api/benches", source: INDEX_SOURCE },
      { method: "DELETE", path: "/api/projects/:id", source: "server/routes/projects.ts" },
    ]);
    expect(markdown).toContain("Do not edit by hand");
    expect(markdown).toContain("| Method | Path | Source |");
    expect(markdown).toContain("| GET | `/api/benches` | `server/index.ts` |");
    expect(markdown).toContain("| DELETE | `/api/projects/:id` | `server/routes/projects.ts` |");
    expect(markdown).toContain("2 in total");
  });
});

describe("renderInventory", () => {
  it("is byte-stable: re-rendering reproduces the committed docs/routes.md exactly", async () => {
    // The CI drift guard depends on this. Prettier realigns markdown table
    // pipes, so the renderer formats its own output with the repo config.
    expect(await renderInventory()).toBe(readFileSync(outPath, "utf8"));
  });
});

describe("generate()", () => {
  it("writes the artifact and logs its path without re-introducing drift", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // The file is already committed and the render is pure, so this is a no-op
    // on disk that still exercises the write path.
    await generate();
    expect(log).toHaveBeenCalledExactlyOnceWith(`Wrote ${outPath}`);
    expect(readFileSync(outPath, "utf8")).toBe(await renderInventory());
  });
});
