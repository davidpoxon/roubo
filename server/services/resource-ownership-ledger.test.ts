import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PersistedState } from "@roubo/shared";

// Mirror state.test.ts: the ledger imports loadState/saveState from the real
// state module, so we mock the filesystem underneath it rather than the state
// module itself. That exercises the real persistence round-trip (the
// load -> mutate -> save path the ledger relies on for restart survival).
vi.mock("node:os", () => ({ default: { homedir: () => "/mock-home" } }));
vi.mock("node:url", () => ({
  fileURLToPath: () => "/projects/my-checkout/server/services/state.ts",
}));

const fsMocks = {
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
};

vi.mock("node:fs", () => ({ default: fsMocks }));

let ledger: typeof import("./resource-ownership-ledger.js");

// In-memory model of the filesystem so sequential ledger calls within one test
// chain correctly: each mutating call loads the latest persisted state, applies
// its change, and saves via state.ts's atomicWrite (writeFileSync to "<path>.tmp"
// then renameSync to "<path>"). A static readFileSync mock would feed every load
// the original seed, masking the real load -> mutate -> save round-trip.
let disk: Map<string, string>;

/**
 * Seeds the modelled disk with the given state.json contents, so the next
 * loadState() inside the ledger reads it back. Passing null leaves state.json
 * absent (loadState returns its default).
 */
function seedState(state: PersistedState | null): void {
  disk.clear();
  if (state !== null) {
    disk.set("/mock-home/.roubo/state.json", JSON.stringify(state));
  }
}

/** Parses the current persisted state.json from the modelled disk. */
function lastWritten(): PersistedState {
  return JSON.parse(disk.get("/mock-home/.roubo/state.json") as string) as PersistedState;
}

beforeEach(async () => {
  disk = new Map<string, string>();
  fsMocks.mkdirSync = vi.fn();
  fsMocks.existsSync = vi.fn((p: string) => disk.has(p));
  fsMocks.readFileSync = vi.fn((p: string) => {
    const content = disk.get(p);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file '${p}'`);
    }
    return content;
  });
  fsMocks.writeFileSync = vi.fn((p: string, data: string) => {
    disk.set(p, data);
  });
  fsMocks.renameSync = vi.fn((from: string, to: string) => {
    const content = disk.get(from);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file '${from}'`);
    }
    disk.delete(from);
    disk.set(to, content);
  });

  process.env.ROUBO_PRODUCTION = "1";
  vi.resetModules();
  ledger = await import("./resource-ownership-ledger.js");
});

afterEach(() => {
  delete process.env.ROUBO_PRODUCTION;
});

describe("recordProcess", () => {
  it("creates an entry and records the process id when none exists", () => {
    seedState({ benches: [] });
    ledger.recordProcess("plugin-a", "demo", 1, "proc-1");
    const written = lastWritten();
    expect(written.resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["proc-1"],
        composeProjects: [],
      },
    ]);
  });

  it("appends a second process id to an existing entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });
    ledger.recordProcess("plugin-a", "demo", 1, "proc-2");
    expect(lastWritten().resourceOwnership?.[0].processIds).toEqual(["proc-1", "proc-2"]);
  });

  it("is idempotent: recording the same process id twice does not duplicate it", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });
    ledger.recordProcess("plugin-a", "demo", 1, "proc-1");
    expect(lastWritten().resourceOwnership?.[0].processIds).toEqual(["proc-1"]);
  });

  it("keys entries by (pluginId, projectId, benchId): same plugin, different bench is a distinct entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });
    ledger.recordProcess("plugin-a", "demo", 2, "proc-9");
    const entries = lastWritten().resourceOwnership ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.benchId === 2)?.processIds).toEqual(["proc-9"]);
  });
});

describe("recordComposeProject", () => {
  it("records a compose project name following the roubo-<projectId>-bench-<N> convention", () => {
    seedState({ benches: [] });
    ledger.recordComposeProject("plugin-db", "demo", 3, "roubo-myproj-bench-3");
    const written = lastWritten();
    expect(written.resourceOwnership).toEqual([
      {
        pluginId: "plugin-db",
        projectId: "demo",
        benchId: 3,
        processIds: [],
        composeProjects: ["roubo-myproj-bench-3"],
      },
    ]);
  });

  it("is idempotent: recording the same compose project twice does not duplicate it", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-db",
          projectId: "demo",
          benchId: 3,
          processIds: [],
          composeProjects: ["roubo-myproj-bench-3"],
        },
      ],
    });
    ledger.recordComposeProject("plugin-db", "demo", 3, "roubo-myproj-bench-3");
    expect(lastWritten().resourceOwnership?.[0].composeProjects).toEqual(["roubo-myproj-bench-3"]);
  });

  it("records both a process and a compose project on the same entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-x",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });
    ledger.recordComposeProject("plugin-x", "demo", 1, "roubo-p-bench-1");
    const entry = lastWritten().resourceOwnership?.[0];
    expect(entry?.processIds).toEqual(["proc-1"]);
    expect(entry?.composeProjects).toEqual(["roubo-p-bench-1"]);
  });
});

describe("clearEntry", () => {
  it("removes the matching (pluginId, projectId, benchId) entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });
    ledger.clearEntry("plugin-a", "demo", 1);
    expect(lastWritten().resourceOwnership).toEqual([]);
  });

  it("leaves sibling entries untouched when clearing one", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 2,
          processIds: ["proc-2"],
          composeProjects: [],
        },
        {
          pluginId: "plugin-b",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-3"],
          composeProjects: [],
        },
      ],
    });
    ledger.clearEntry("plugin-a", "demo", 1);
    const remaining = lastWritten().resourceOwnership ?? [];
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => `${e.pluginId}:${e.benchId}`)).toEqual([
      "plugin-a:2",
      "plugin-b:1",
    ]);
  });

  it("is a no-op (persists an unchanged ledger) when no matching entry exists", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });
    ledger.clearEntry("plugin-z", "demo", 99);
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["proc-1"],
        composeProjects: [],
      },
    ]);
  });

  it("tolerates a state file with no resourceOwnership field", () => {
    seedState({ benches: [] });
    ledger.clearEntry("plugin-a", "demo", 1);
    expect(lastWritten().resourceOwnership).toEqual([]);
  });
});

describe("removeProcess", () => {
  it("removes one process id but keeps a sibling process on the same entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["plugin-a:1:web", "plugin-a:1:worker"],
          composeProjects: [],
        },
      ],
    });
    ledger.removeProcess("plugin-a", "demo", 1, "plugin-a:1:web");
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["plugin-a:1:worker"],
        composeProjects: [],
      },
    ]);
  });

  it("drops the entry entirely once its last process and compose project are gone", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["plugin-a:1:web"],
          composeProjects: [],
        },
      ],
    });
    ledger.removeProcess("plugin-a", "demo", 1, "plugin-a:1:web");
    expect(lastWritten().resourceOwnership).toEqual([]);
  });

  it("keeps the entry when a compose project still remains after the process is removed", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["plugin-a:1:db:migration"],
          composeProjects: ["roubo-p-bench-1"],
        },
      ],
    });
    ledger.removeProcess("plugin-a", "demo", 1, "plugin-a:1:db:migration");
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: [],
        composeProjects: ["roubo-p-bench-1"],
      },
    ]);
  });

  it("is a no-op (persists an unchanged ledger) when no matching entry exists", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["plugin-a:1:web"],
          composeProjects: [],
        },
      ],
    });
    ledger.removeProcess("plugin-z", "demo", 99, "plugin-z:99:web");
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["plugin-a:1:web"],
        composeProjects: [],
      },
    ]);
  });

  it("tolerates a state file with no resourceOwnership field", () => {
    seedState({ benches: [] });
    ledger.removeProcess("plugin-a", "demo", 1, "plugin-a:1:web");
    expect(lastWritten().resourceOwnership).toEqual([]);
  });
});

describe("removeComposeProject", () => {
  it("removes one compose project but keeps sibling rows on the same entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["plugin-a:1:db:migration"],
          composeProjects: ["roubo-p-bench-1"],
        },
      ],
    });
    ledger.removeComposeProject("plugin-a", "demo", 1, "roubo-p-bench-1");
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["plugin-a:1:db:migration"],
        composeProjects: [],
      },
    ]);
  });

  it("drops the entry once its last compose project and process are gone", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: [],
          composeProjects: ["roubo-p-bench-1"],
        },
      ],
    });
    ledger.removeComposeProject("plugin-a", "demo", 1, "roubo-p-bench-1");
    expect(lastWritten().resourceOwnership).toEqual([]);
  });

  it("is a no-op when the compose project name is absent from the entry", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: [],
          composeProjects: ["roubo-p-bench-1"],
        },
      ],
    });
    ledger.removeComposeProject("plugin-a", "demo", 1, "roubo-other-bench-9");
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: [],
        composeProjects: ["roubo-p-bench-1"],
      },
    ]);
  });
});

describe("getEntry", () => {
  it("returns the entry for (pluginId, projectId, benchId) when present", () => {
    seedState({
      benches: [],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: ["roubo-p-bench-1"],
        },
      ],
    });
    expect(ledger.getEntry("plugin-a", "demo", 1)).toEqual({
      pluginId: "plugin-a",
      projectId: "demo",
      benchId: 1,
      processIds: ["proc-1"],
      composeProjects: ["roubo-p-bench-1"],
    });
  });

  it("returns undefined when no entry matches", () => {
    seedState({ benches: [], resourceOwnership: [] });
    expect(ledger.getEntry("plugin-a", "demo", 1)).toBeUndefined();
  });

  it("returns undefined when the state file has no resourceOwnership field", () => {
    seedState({ benches: [] });
    expect(ledger.getEntry("plugin-a", "demo", 1)).toBeUndefined();
  });
});

describe("getAllEntries", () => {
  it("returns every entry", () => {
    const entries = [
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["proc-1"],
        composeProjects: [],
      },
      {
        pluginId: "plugin-b",
        projectId: "demo",
        benchId: 2,
        processIds: [],
        composeProjects: ["roubo-q-bench-2"],
      },
    ];
    seedState({ benches: [], resourceOwnership: entries });
    expect(ledger.getAllEntries()).toEqual(entries);
  });

  it("returns an empty array when the ledger is empty or missing", () => {
    seedState({ benches: [] });
    expect(ledger.getAllEntries()).toEqual([]);
  });

  it("returns an empty array when the state file does not exist", () => {
    seedState(null);
    expect(ledger.getAllEntries()).toEqual([]);
  });
});

describe("restart survival (AC: the ledger survives a host restart)", () => {
  it("a recorded entry is read back after a simulated restart (load -> record -> reload)", () => {
    // Start from a fresh state file.
    seedState({ benches: [] });
    ledger.recordProcess("plugin-a", "demo", 1, "proc-1");
    ledger.recordComposeProject("plugin-a", "demo", 1, "roubo-p-bench-1");

    // Simulate a host restart: the next load reads back exactly what was last
    // written to state.json on disk.
    const persisted = lastWritten();
    seedState(persisted);

    expect(ledger.getEntry("plugin-a", "demo", 1)).toEqual({
      pluginId: "plugin-a",
      projectId: "demo",
      benchId: 1,
      processIds: ["proc-1"],
      composeProjects: ["roubo-p-bench-1"],
    });
  });
});

describe("state.json preservation (AC: additive, no schema migration)", () => {
  it("preserves benches and other top-level fields when writing the ledger", () => {
    seedState({
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "main",
          workspacePath: "/w",
          ports: { web: 3000 },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      schemaVersion: 1,
      notices: { "only-to-do-default-v1": "seeded" },
    });

    ledger.recordProcess("plugin-a", "demo", 1, "proc-1");

    const written = lastWritten();
    expect(written.benches).toHaveLength(1);
    expect(written.benches[0].projectId).toBe("project1");
    expect(written.benches[0].ports).toEqual({ web: 3000 });
    expect(written.schemaVersion).toBe(1);
    expect(written.notices).toEqual({ "only-to-do-default-v1": "seeded" });
    expect(written.resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo",
        benchId: 1,
        processIds: ["proc-1"],
        composeProjects: [],
      },
    ]);
  });

  it("clearing an entry preserves the rest of state.json", () => {
    seedState({
      benches: [
        {
          id: 1,
          projectId: "project1",
          branch: "main",
          workspacePath: "/w",
          ports: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      resourceOwnership: [
        {
          pluginId: "plugin-a",
          projectId: "demo",
          benchId: 1,
          processIds: ["proc-1"],
          composeProjects: [],
        },
      ],
    });

    ledger.clearEntry("plugin-a", "demo", 1);

    const written = lastWritten();
    expect(written.benches).toHaveLength(1);
    expect(written.resourceOwnership).toEqual([]);
  });
});

// #1499: bench ids restart at 1 in each project, so the project is part of the key.
describe("project scoping (#1499)", () => {
  it("gives two projects with the same bench id separate rows", () => {
    seedState({ benches: [] });
    ledger.recordProcess("plugin-a", "demo-a", 1, "plugin-a:1:web");
    ledger.recordProcess("plugin-a", "demo-b", 1, "plugin-a:1:web");
    ledger.recordComposeProject("plugin-a", "demo-a", 1, "roubo-demo-a-bench-1");
    ledger.recordComposeProject("plugin-a", "demo-b", 1, "roubo-demo-b-bench-1");
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo-a",
        benchId: 1,
        processIds: ["plugin-a:1:web"],
        composeProjects: ["roubo-demo-a-bench-1"],
      },
      {
        pluginId: "plugin-a",
        projectId: "demo-b",
        benchId: 1,
        processIds: ["plugin-a:1:web"],
        composeProjects: ["roubo-demo-b-bench-1"],
      },
    ]);
  });

  it("clearing one project's bench leaves another project's bench with the same id", () => {
    seedState({ benches: [] });
    ledger.recordComposeProject("plugin-a", "demo-a", 1, "roubo-demo-a-bench-1");
    ledger.recordComposeProject("plugin-a", "demo-b", 1, "roubo-demo-b-bench-1");
    ledger.clearEntry("plugin-a", "demo-a", 1);
    expect(lastWritten().resourceOwnership).toEqual([
      {
        pluginId: "plugin-a",
        projectId: "demo-b",
        benchId: 1,
        processIds: [],
        composeProjects: ["roubo-demo-b-bench-1"],
      },
    ]);
  });

  it("per-resource removal touches only the named project's row", () => {
    seedState({ benches: [] });
    ledger.recordProcess("plugin-a", "demo-a", 1, "plugin-a:1:web");
    ledger.recordProcess("plugin-a", "demo-b", 1, "plugin-a:1:web");
    ledger.removeProcess("plugin-a", "demo-a", 1, "plugin-a:1:web");
    expect(ledger.getEntry("plugin-a", "demo-a", 1)).toBeUndefined();
    expect(ledger.getEntry("plugin-a", "demo-b", 1)?.processIds).toEqual(["plugin-a:1:web"]);
  });
});

// #1499: a state.json written before the project id existed still loads; its rows
// carry no projectId, and only a clear with an undefined project matches them.
describe("rows written before #1499", () => {
  const legacyRow = {
    pluginId: "plugin-db",
    benchId: 1,
    processIds: [],
    composeProjects: ["roubo-demo-bench-1"],
  };

  it("load unchanged", () => {
    seedState({ benches: [], resourceOwnership: [legacyRow] });
    expect(ledger.getAllEntries()).toEqual([legacyRow]);
  });

  it("are not merged into a new project-scoped row for the same bench id", () => {
    seedState({ benches: [], resourceOwnership: [legacyRow] });
    ledger.recordComposeProject("plugin-db", "demo", 1, "roubo-demo-bench-1");
    expect(lastWritten().resourceOwnership).toEqual([
      legacyRow,
      {
        pluginId: "plugin-db",
        projectId: "demo",
        benchId: 1,
        processIds: [],
        composeProjects: ["roubo-demo-bench-1"],
      },
    ]);
  });

  it("are cleared by their own key, which has no project", () => {
    seedState({
      benches: [],
      resourceOwnership: [legacyRow, { ...legacyRow, projectId: "demo" }],
    });
    ledger.clearEntry("plugin-db", undefined, 1);
    expect(lastWritten().resourceOwnership).toEqual([{ ...legacyRow, projectId: "demo" }]);
  });
});
