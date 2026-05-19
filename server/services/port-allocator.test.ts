import { describe, it, expect } from "vitest";
import { allocatePorts, checkPortConflicts } from "./port-allocator.js";
import { makeConfig, makeProject } from "../test/fixtures.js";

describe("allocatePorts", () => {
  it("returns base ports for bench 1", () => {
    const config = makeConfig({
      ports: { backend: { base: 5000 }, frontend: { base: 3000 } },
    });
    expect(allocatePorts(config, 1)).toEqual({ backend: 5000, frontend: 3000 });
  });

  it("offsets ports by bench number minus 1", () => {
    const config = makeConfig({
      ports: { backend: { base: 5000 }, frontend: { base: 3000 } },
    });
    expect(allocatePorts(config, 3)).toEqual({ backend: 5002, frontend: 3002 });
  });

  it("returns empty object when no ports defined", () => {
    const config = makeConfig({ ports: {} });
    expect(allocatePorts(config, 1)).toEqual({});
  });

  it("handles single port", () => {
    const config = makeConfig({ ports: { db: { base: 1433 } } });
    expect(allocatePorts(config, 5)).toEqual({ db: 1437 });
  });
});

describe("checkPortConflicts", () => {
  it("returns empty when no existing projects", () => {
    const newProject = {
      id: "project1",
      config: makeConfig({ ports: { web: { base: 3000 } } }),
    };
    expect(checkPortConflicts(newProject, [])).toEqual([]);
  });

  it("skips self when checking conflicts", () => {
    const config = makeConfig({ ports: { web: { base: 3000 } } });
    const newProject = { id: "test-project", config };
    const existing = [makeProject({ id: "test-project", config })];
    expect(checkPortConflicts(newProject, existing)).toEqual([]);
  });

  it("detects overlapping port ranges", () => {
    const newProject = {
      id: "project-new",
      config: makeConfig({
        ports: { web: { base: 3000 } },
        benches: { max: 5 },
      }),
    };
    const existing = [
      makeProject({
        id: "project-existing",
        config: makeConfig({
          ports: { web: { base: 3002 } },
          benches: { max: 5 },
        }),
      }),
    ];
    const conflicts = checkPortConflicts(newProject, existing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toContain("Port conflict");
    expect(conflicts[0]).toContain("project-new.web");
    expect(conflicts[0]).toContain("project-existing.web");
  });

  it("allows adjacent non-overlapping ranges", () => {
    const newProject = {
      id: "project-new",
      config: makeConfig({
        ports: { web: { base: 3000 } },
        benches: { max: 3 },
      }),
    };
    const existing = [
      makeProject({
        id: "project-existing",
        config: makeConfig({
          ports: { web: { base: 3003 } },
          benches: { max: 3 },
        }),
      }),
    ];
    // new: 3000-3002, existing: 3003-3005 — no overlap
    expect(checkPortConflicts(newProject, existing)).toEqual([]);
  });

  it("detects conflicts per port independently", () => {
    const newProject = {
      id: "project-new",
      config: makeConfig({
        ports: { web: { base: 3000 }, api: { base: 5000 } },
        benches: { max: 3 },
      }),
    };
    const existing = [
      makeProject({
        id: "project-existing",
        config: makeConfig({
          ports: { web: { base: 3001 }, api: { base: 6000 } },
          benches: { max: 3 },
        }),
      }),
    ];
    const conflicts = checkPortConflicts(newProject, existing);
    // web overlaps (3000-3002 vs 3001-3003), api doesn't (5000-5002 vs 6000-6002)
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toContain("web");
  });

  it("detects conflicts across multiple existing projects", () => {
    const newProject = {
      id: "project-new",
      config: makeConfig({
        ports: { web: { base: 3000 }, api: { base: 5000 } },
        benches: { max: 3 },
      }),
    };
    const existing = [
      makeProject({
        id: "project-a",
        config: makeConfig({
          ports: { web: { base: 3001 } },
          benches: { max: 3 },
        }),
      }),
      makeProject({
        id: "project-b",
        config: makeConfig({
          ports: { db: { base: 5001 } },
          benches: { max: 3 },
        }),
      }),
    ];
    const conflicts = checkPortConflicts(newProject, existing);
    expect(conflicts.length).toBe(2);
  });
});
