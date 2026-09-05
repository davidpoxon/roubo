import { describe, expect, it } from "vitest";

import { loadTree, scanPins } from "./dependency-pin-guard.mjs";

// A minimal but realistic tree: a root manifest, one workspace, and the
// lockfile records that mirror them. Overrides are merged in per test so each
// case states only what it is about.
function tree({
  rootDeps = {},
  wsDeps = {},
  lockRootDeps = rootDeps,
  lockWsDeps = wsDeps,
}: {
  rootDeps?: Record<string, string>;
  wsDeps?: Record<string, string>;
  lockRootDeps?: Record<string, string>;
  lockWsDeps?: Record<string, string>;
}) {
  return {
    lock: {
      packages: {
        "": { dependencies: lockRootDeps },
        server: { dependencies: lockWsDeps },
      },
    },
    manifests: {
      "": { name: "roubo", workspaces: ["server"], dependencies: rootDeps },
      server: { name: "@roubo/server", dependencies: wsDeps },
    },
  };
}

describe("scanPins (DependencyPinGuard)", () => {
  it("passes a tree whose specs are exact and match the lockfile verbatim", () => {
    const { lock, manifests } = tree({ wsDeps: { express: "5.2.1" } });
    expect(scanPins(lock, manifests)).toEqual([]);
  });

  it("flags the Dependabot defect: an exact manifest pin recorded with a caret", () => {
    // The regression this guard exists for. `npm ci` accepts this lock,
    // because `^8.6.2` satisfies `8.6.2`, so no other gate sees it.
    const { lock, manifests } = tree({
      wsDeps: { "express-rate-limit": "8.6.2" },
      lockWsDeps: { "express-rate-limit": "^8.6.2" },
    });
    const findings = scanPins(lock, manifests);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("server/package.json");
    expect(findings[0].dependency).toBe("express-rate-limit");
    expect(findings[0].kind).toBe("dependencies");
    expect(findings[0].reason).toMatch(/lockfile records '\^8\.6\.2'/);
  });

  it("flags a range that reaches the manifest itself", () => {
    const { lock, manifests } = tree({ wsDeps: { express: "^5.2.1" } });
    const findings = scanPins(lock, manifests);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/not an exact version/);
  });

  it("flags a tilde range as well as a caret", () => {
    const { lock, manifests } = tree({ wsDeps: { express: "~5.2.1" } });
    expect(scanPins(lock, manifests)[0].reason).toMatch(/not an exact version/);
  });

  it("flags a dependency the lockfile never recorded", () => {
    const { lock, manifests } = tree({
      wsDeps: { express: "5.2.1" },
      lockWsDeps: {},
    });
    const findings = scanPins(lock, manifests);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toMatch(/absent from the lockfile/);
  });

  it("flags a dependency the lockfile still carries after the manifest dropped it", () => {
    const { lock, manifests } = tree({
      wsDeps: {},
      lockWsDeps: { express: "5.2.1" },
    });
    const findings = scanPins(lock, manifests);
    expect(findings).toHaveLength(1);
    expect(findings[0].dependency).toBe("express");
    expect(findings[0].reason).toMatch(/no longer declared here/);
  });

  it("exempts the repo's own workspace packages, which are linked not pinned", () => {
    // `@roubo/shared` is declared as `*` from a workspace and `file:./shared`
    // from the root. Neither is an exact version, and neither should flag.
    const findings = scanPins(
      {
        packages: {
          "": { dependencies: { "@roubo/shared": "file:./shared" } },
          shared: {},
          server: { dependencies: { "@roubo/shared": "*" } },
        },
      },
      {
        "": {
          name: "roubo",
          workspaces: ["shared", "server"],
          dependencies: { "@roubo/shared": "file:./shared" },
        },
        shared: { name: "@roubo/shared" },
        server: { name: "@roubo/server", dependencies: { "@roubo/shared": "*" } },
      },
    );
    expect(findings).toEqual([]);
  });

  it("accepts an exact prerelease version", () => {
    const { lock, manifests } = tree({ wsDeps: { vite: "8.2.0-beta.3" } });
    expect(scanPins(lock, manifests)).toEqual([]);
  });

  it("checks devDependencies, not just dependencies", () => {
    const findings = scanPins(
      {
        packages: {
          "": {},
          electron: { devDependencies: { electron: "^43.3.0" } },
        },
      },
      {
        "": { name: "roubo", workspaces: ["electron"] },
        electron: { name: "@roubo/electron", devDependencies: { electron: "43.3.0" } },
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("devDependencies");
  });

  it("flags a workspace the lockfile has no record of at all", () => {
    const findings = scanPins(
      { packages: { "": {} } },
      {
        "": { name: "roubo", workspaces: ["server"] },
        server: { name: "@roubo/server", dependencies: { express: "5.2.1" } },
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("server/package.json");
    expect(findings[0].reason).toMatch(/no record of this workspace/);
  });

  it("reports every violation in the tree, not just the first", () => {
    const findings = scanPins(
      {
        packages: {
          "": {},
          client: { dependencies: { "@codemirror/view": "^6.43.8", react: "^19.0.0" } },
        },
      },
      {
        "": { name: "roubo", workspaces: ["client"] },
        client: {
          name: "@roubo/client",
          dependencies: { "@codemirror/view": "6.43.8", react: "^19.0.0" },
        },
      },
    );
    // The caret-in-lock drift, plus a range in the manifest that the lock
    // agrees with (so it flags once, on rule 1 only).
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.dependency).sort()).toEqual(["@codemirror/view", "react"]);
  });
});

describe("loadTree (DependencyPinGuard)", () => {
  it("reads the root manifest, every workspace manifest, and the lockfile", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "roubo", workspaces: ["server"] }),
      "server/package.json": JSON.stringify({ name: "@roubo/server" }),
      "package-lock.json": JSON.stringify({ packages: { "": {} } }),
    };
    const { lock, manifests } = loadTree((f: string) => {
      if (!(f in files)) throw new Error(`no such file: ${f}`);
      return files[f];
    });
    expect(Object.keys(manifests).sort()).toEqual(["", "server"]);
    expect(manifests.server.name).toBe("@roubo/server");
    expect(lock.packages).toBeDefined();
  });
});

describe("the committed tree (DependencyPinGuard)", () => {
  it("has no dependency-pin violations", async () => {
    const { readFileSync } = await import("node:fs");
    const { lock, manifests } = loadTree((f: string) => readFileSync(f, "utf8"));
    expect(scanPins(lock, manifests)).toEqual([]);
  });
});

describe("scanPins overrides (DependencyPinGuard)", () => {
  it("accepts exact overrides", () => {
    const findings = scanPins(
      { packages: { "": {} } },
      { "": { name: "roubo", workspaces: [], overrides: { tar: "7.5.22" } } },
    );
    expect(findings).toEqual([]);
  });

  it("flags a range in an override", () => {
    const findings = scanPins(
      { packages: { "": {} } },
      {
        "": {
          name: "roubo",
          workspaces: [],
          overrides: { "@electron/rebuild": "^4.2.0" },
        },
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("overrides");
    expect(findings[0].dependency).toBe("@electron/rebuild");
    expect(findings[0].reason).toMatch(/not an exact version/);
  });

  it("recurses into a nested override scope and reports its path", () => {
    const findings = scanPins(
      { packages: { "": {} } },
      {
        "": {
          name: "roubo",
          workspaces: [],
          overrides: { foo: { bar: "^1.0.0" } },
        },
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("overrides.foo");
    expect(findings[0].dependency).toBe("bar");
  });
});
