import { describe, expect, it } from "vitest";
import type { RouboConfig } from "@roubo/shared";
import { makeConfig } from "../test/fixtures.js";
import {
  benchConfig,
  hashDefinitions,
  isBenchStale,
  takeComponentSnapshot,
} from "./bench-config.js";

function lantern(overrides: Partial<RouboConfig> = {}): RouboConfig {
  return makeConfig({
    components: {
      api: { plugin: { id: "process" }, config: { command: "npm start" } },
    },
    ports: { api: { base: 4000 } },
    benches: { max: 3, setup: "npm ci" },
    ...overrides,
  });
}

describe("hashDefinitions", () => {
  it("ignores key order", () => {
    const a = lantern({ ports: { api: { base: 4000 }, web: { base: 5000 } } });
    const b = lantern({ ports: { web: { base: 5000 }, api: { base: 4000 } } });
    expect(hashDefinitions(a)).toBe(hashDefinitions(b));
  });

  it("HR-TC-007: covers components, ports and the setup command, and not tools", () => {
    const base = hashDefinitions(lantern());
    expect(
      hashDefinitions(
        lantern({ components: { api: { plugin: { id: "process" }, config: { command: "x" } } } }),
      ),
    ).not.toBe(base);
    expect(hashDefinitions(lantern({ ports: { api: { base: 4100 } } }))).not.toBe(base);
    expect(hashDefinitions(lantern({ benches: { max: 3, setup: "pnpm i" } }))).not.toBe(base);
    expect(
      hashDefinitions(lantern({ benches: { max: 3, setup: "npm ci", shell: true } })),
    ).not.toBe(base);
    // Sections outside the snapshot leave the hash as it was.
    expect(
      hashDefinitions(
        lantern({ tools: [{ type: "browser", name: "App", icon: "globe", url: "http://x" }] }),
      ),
    ).toBe(base);
    expect(hashDefinitions(lantern({ benches: { max: 9, setup: "npm ci" } }))).toBe(base);
  });
});

describe("benchConfig", () => {
  it("HR-TC-006: a bench with no snapshot reads the live config unchanged", () => {
    const live = lantern();
    expect(benchConfig({}, live)).toBe(live);
  });

  it("lays the snapshot over the frozen sections and reads every other section live", () => {
    const setUp = lantern();
    const componentSnapshot = takeComponentSnapshot(setUp);
    const live = lantern({
      components: { web: { plugin: { id: "process" }, config: { command: "vite" } } },
      ports: { web: { base: 5000 } },
      benches: { max: 7 },
      tools: [{ type: "browser", name: "App", icon: "globe", url: "http://x" }],
    });

    const config = benchConfig({ componentSnapshot }, live);

    expect(config.components).toEqual(setUp.components);
    expect(config.ports).toEqual(setUp.ports);
    expect(config.benches).toEqual({ max: 7, setup: "npm ci" });
    expect(config.tools).toEqual(live.tools);
  });

  it("drops a live setup command the snapshot did not have", () => {
    const componentSnapshot = takeComponentSnapshot(lantern({ benches: { max: 3 } }));
    const config = benchConfig({ componentSnapshot }, lantern());
    expect(config.benches.setup).toBeUndefined();
  });
});

describe("takeComponentSnapshot", () => {
  it("is a copy that a later change to the live config does not reach", () => {
    const live = lantern();
    const snapshot = takeComponentSnapshot(live, new Date("2026-11-09T10:00:00.000Z"));
    (live.components.api.config as Record<string, unknown>).command = "changed";
    expect(snapshot.components.api.config).toEqual({ command: "npm start" });
    expect(snapshot.takenAt).toBe("2026-11-09T10:00:00.000Z");
    expect(snapshot.benches).toEqual({ setup: "npm ci" });
  });
});

describe("isBenchStale", () => {
  it("HR-TC-007: is true after a change, false after a revert, and false after a tools-only change", () => {
    const componentSnapshot = takeComponentSnapshot(lantern());
    const bench = { componentSnapshot };
    expect(isBenchStale(bench, lantern({ ports: { api: { base: 4100 } } }))).toBe(true);
    expect(isBenchStale(bench, lantern())).toBe(false);
    expect(
      isBenchStale(
        bench,
        lantern({ tools: [{ type: "browser", name: "App", icon: "globe", url: "http://x" }] }),
      ),
    ).toBe(false);
  });

  it("HR-TC-006: a bench with no snapshot is never stale", () => {
    expect(isBenchStale({}, lantern({ ports: { api: { base: 4100 } } }))).toBe(false);
  });

  it("is false when the project has no valid config", () => {
    expect(isBenchStale({ componentSnapshot: takeComponentSnapshot(lantern()) }, undefined)).toBe(
      false,
    );
  });
});
