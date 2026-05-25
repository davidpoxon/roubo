import { describe, it, expect } from "vitest";
import type {
  RouboConfig,
  ProjectConfig,
  LayoutConfig,
  ComponentConfig,
  PortConfig,
  ToolConfig,
  InspectionConfig,
  BenchesConfig,
  UserConfig,
  RepoScanResult,
} from "@roubo/shared";
import {
  createInitialState,
  nextAvailablePort,
  wizardReducer,
  validateSection,
  WIZARD_SECTIONS,
  type WizardState,
  type WizardAction,
  type SectionStatus,
} from "./wizardReducer";

function makeState(overrides?: Partial<WizardState>): WizardState {
  return {
    ...createInitialState("/repo", false),
    ...overrides,
  };
}

describe("validateSection", () => {
  describe("project", () => {
    it("returns undefined when all project fields are absent", () => {
      expect(validateSection("project", {})).toBeUndefined();
    });

    it("returns valid when all required fields are present", () => {
      expect(
        validateSection("project", {
          project: {
            name: "my-project",
            displayName: "My Project",
            type: "web",
            repo: "org/repo",
          },
        }),
      ).toBe("valid");
    });

    it("returns invalid when name does not match pattern", () => {
      expect(
        validateSection("project", {
          project: {
            name: "My Project",
            displayName: "My Project",
            type: "web",
            repo: "org/repo",
          },
        }),
      ).toBe("invalid");
    });

    // FR-070 (WU-057): repo is owned by the plugin Configure modal, so the
    // wizard's Identity step no longer requires it.
    it("returns valid even when repo is missing", () => {
      expect(
        validateSection("project", {
          project: { name: "my-project", displayName: "My Project", type: "web" },
        }),
      ).toBe("valid");
    });
  });

  describe("layout", () => {
    it("returns undefined when type is absent", () => {
      expect(validateSection("layout", {})).toBeUndefined();
    });

    it("returns valid for single-repo", () => {
      expect(validateSection("layout", { layout: { type: "single-repo" } })).toBe("valid");
    });

    it("returns valid for monorepo", () => {
      expect(validateSection("layout", { layout: { type: "monorepo" } })).toBe("valid");
    });

    // FR-070 (WU-057): submodules moved to the plugin Configure modal; the
    // wizard's Layout step only locks in the structure type now, so meta-repo
    // is valid with or without submodules at this stage.
    it("returns valid for meta-repo regardless of submodules", () => {
      expect(validateSection("layout", { layout: { type: "meta-repo" } })).toBe("valid");
      expect(
        validateSection("layout", {
          layout: { type: "meta-repo", submodules: { backend: "backend/" } },
        }),
      ).toBe("valid");
    });
  });

  describe("components", () => {
    it("returns invalid when no components", () => {
      expect(validateSection("components", {})).toBe("invalid");
    });

    it("returns invalid when empty components object", () => {
      expect(validateSection("components", { components: {} })).toBe("invalid");
    });

    it("returns invalid for process component with empty command", () => {
      expect(
        validateSection("components", {
          components: { server: { type: "process", command: "" } },
          ports: { server: { base: 3000 } },
        }),
      ).toBe("invalid");
    });

    it("returns valid for process component with command", () => {
      expect(
        validateSection("components", {
          components: { server: { type: "process", command: "npm start" } },
          ports: { server: { base: 3000 } },
        }),
      ).toBe("valid");
    });

    it("returns invalid for database component with only type set", () => {
      expect(
        validateSection("components", {
          components: { db: { type: "database" } },
          ports: { db: { base: 3000 } },
        }),
      ).toBe("invalid");
    });

    it("returns valid for database component with docker composeFile and service", () => {
      expect(
        validateSection("components", {
          components: {
            db: {
              type: "database",
              docker: {
                composeFile: "docker-compose.yml",
                service: "postgres",
              },
            },
          },
          ports: { db: { base: 3000 } },
        }),
      ).toBe("valid");
    });

    it("returns invalid when port base is out of range", () => {
      expect(
        validateSection("components", {
          components: { server: { type: "process", command: "npm start" } },
          ports: { server: { base: 0 } },
        }),
      ).toBe("invalid");
    });
  });

  describe("tools", () => {
    it("returns valid when no tools configured", () => {
      expect(validateSection("tools", {})).toBe("valid");
    });

    it("returns valid when tools array is empty", () => {
      expect(validateSection("tools", { tools: [] })).toBe("valid");
    });

    it("returns invalid when browser tool has no url", () => {
      expect(
        validateSection("tools", {
          tools: [{ name: "App", icon: "globe", type: "browser" }],
        }),
      ).toBe("invalid");
    });

    it("returns invalid when tool name is empty", () => {
      expect(
        validateSection("tools", {
          tools: [
            {
              name: "",
              icon: "globe",
              type: "browser",
              url: "http://localhost",
            },
          ],
        }),
      ).toBe("invalid");
    });

    it("returns valid when browser tool is fully configured", () => {
      expect(
        validateSection("tools", {
          tools: [
            {
              name: "App",
              icon: "globe",
              type: "browser",
              url: "http://localhost",
            },
          ],
        }),
      ).toBe("valid");
    });

    it("returns invalid when shell tool has no command", () => {
      expect(
        validateSection("tools", {
          tools: [{ name: "Shell", icon: "terminal", type: "shell" }],
        }),
      ).toBe("invalid");
    });

    it("returns valid when shell tool is fully configured", () => {
      expect(
        validateSection("tools", {
          tools: [{ name: "Shell", icon: "terminal", type: "shell", command: "bash" }],
        }),
      ).toBe("valid");
    });
  });

  describe("users", () => {
    it("returns valid when no users configured", () => {
      expect(validateSection("users", {})).toBe("valid");
    });

    it("returns valid when users array is empty", () => {
      expect(validateSection("users", { users: [] })).toBe("valid");
    });

    it("returns valid when user has a name and empty properties", () => {
      expect(
        validateSection("users", {
          users: [{ name: "alice", properties: {} }],
        }),
      ).toBe("valid");
    });

    it("returns invalid when user name is empty string", () => {
      expect(validateSection("users", { users: [{ name: "", properties: {} }] })).toBe("invalid");
    });

    it("returns invalid when user name is only whitespace", () => {
      expect(validateSection("users", { users: [{ name: "   ", properties: {} }] })).toBe(
        "invalid",
      );
    });

    it("returns valid when user has properties with non-empty keys", () => {
      expect(
        validateSection("users", {
          users: [{ name: "alice", properties: { role: "admin" } }],
        }),
      ).toBe("valid");
    });

    it("returns invalid when a property key is empty", () => {
      expect(
        validateSection("users", {
          users: [{ name: "alice", properties: { "": "admin" } }],
        }),
      ).toBe("invalid");
    });

    it("returns valid when property value is empty string", () => {
      expect(
        validateSection("users", {
          users: [{ name: "alice", properties: { role: "" } }],
        }),
      ).toBe("valid");
    });
  });

  describe("inspection", () => {
    it("returns undefined when inspection is absent", () => {
      expect(validateSection("inspection", {})).toBeUndefined();
    });

    it("returns valid when all inspection fields are empty", () => {
      expect(
        validateSection("inspection", {
          inspection: { framework: "", directory: "", command: "" },
        }),
      ).toBe("valid");
    });

    it("returns valid when all inspection fields are filled", () => {
      expect(
        validateSection("inspection", {
          inspection: {
            framework: "vitest",
            directory: "tests/",
            command: "npm test",
          },
        }),
      ).toBe("valid");
    });

    it("returns invalid when only some fields are filled", () => {
      expect(
        validateSection("inspection", {
          inspection: { framework: "vitest", directory: "", command: "" },
        }),
      ).toBe("invalid");
    });
  });

  describe("benches", () => {
    it("returns undefined when max is absent", () => {
      expect(validateSection("benches", {})).toBeUndefined();
    });

    it("returns valid for max in range", () => {
      expect(validateSection("benches", { benches: { max: 5 } })).toBe("valid");
    });

    it("returns invalid for max out of range", () => {
      expect(validateSection("benches", { benches: { max: 100 } })).toBe("invalid");
    });

    it("returns invalid for max of 0", () => {
      expect(validateSection("benches", { benches: { max: 0 } })).toBe("invalid");
    });
  });

  describe("review", () => {
    it("returns undefined (not handled by validateSection)", () => {
      expect(validateSection("review", {})).toBeUndefined();
    });
  });
});

describe("createInitialState", () => {
  it("sets all sections to pristine", () => {
    const state = createInitialState("/repo", false);
    for (const s of WIZARD_SECTIONS) {
      expect(state.sectionStatus[s]).toBe("pristine");
    }
  });

  it("sets benches max to 5", () => {
    const state = createInitialState("/repo", false);
    expect(state.config.benches?.max).toBe(5);
  });

  it("sets currentSection to project", () => {
    const state = createInitialState("/repo", false);
    expect(state.currentSection).toBe("project");
  });

  it("initializes currentSubStep to null", () => {
    const state = createInitialState("/repo", false);
    expect(state.currentSubStep).toBeNull();
  });

  it("stores repoPath, isEditMode, and currentProjectId", () => {
    const state = createInitialState("/my/repo", true, "project-123");
    expect(state.repoPath).toBe("/my/repo");
    expect(state.isEditMode).toBe(true);
    expect(state.currentProjectId).toBe("project-123");
  });

  it("initializes empty validationErrors and portConflicts", () => {
    const state = createInitialState("/repo", false);
    expect(state.validationErrors).toEqual({});
    expect(state.portConflicts).toEqual([]);
  });
});

describe("nextAvailablePort", () => {
  it("returns default when no conflicts", () => {
    const result = nextAvailablePort(3000, {}, 5);
    expect(result).toBe(3000);
  });

  it("increments past conflicts", () => {
    const ports: Record<string, PortConfig> = {
      web: { base: 3000 },
    };
    // Port 3000 occupies range 3000-3004 (5 benches), so 3001-3004 all conflict
    const result = nextAvailablePort(3000, ports, 5);
    expect(result).toBeGreaterThan(3000);
  });

  it("handles multiple ports and finds a gap", () => {
    const ports: Record<string, PortConfig> = {
      web: { base: 3000 },
      api: { base: 3005 },
    };
    // 3000-3004 taken by web, 3005-3009 taken by api
    const result = nextAvailablePort(3000, ports, 5);
    expect(result).toBeGreaterThan(3000);
    // Verify it does not overlap with existing ranges
    const ranges = Object.values(ports).map((p) => [p.base, p.base + 4] as const);
    const newRange = [result, result + 4] as const;
    for (const [lo, hi] of ranges) {
      expect(newRange[0] > hi || newRange[1] < lo).toBe(true);
    }
  });
});

describe("wizardReducer", () => {
  describe("UPDATE_PROJECT", () => {
    it("merges project config", () => {
      const state = makeState({
        config: {
          project: {
            name: "old",
            displayName: "Old",
            type: "web",
            repo: "",
          } as ProjectConfig,
        },
      });
      const next = wizardReducer(state, {
        type: "UPDATE_PROJECT",
        payload: { name: "new" },
      });
      expect(next.config.project?.name).toBe("new");
      expect(next.config.project?.displayName).toBe("Old");
    });
  });

  describe("UPDATE_STRUCTURE", () => {
    it("merges structure config", () => {
      const state = makeState({
        config: { layout: { type: "monorepo" } as LayoutConfig },
      });
      const next = wizardReducer(state, {
        type: "UPDATE_STRUCTURE",
        payload: { type: "single-repo" },
      });
      expect(next.config.layout?.type).toBe("single-repo");
    });
  });

  describe("SET_COMPONENTS", () => {
    it("replaces components entirely", () => {
      const components: Record<string, ComponentConfig> = {
        web: { type: "process", command: "npm run dev" },
        api: { type: "process", command: "dotnet run" },
      };
      const state = makeState();
      const next = wizardReducer(state, {
        type: "SET_COMPONENTS",
        payload: components,
      });
      expect(next.config.components).toEqual(components);
    });
  });

  describe("ADD_COMPONENT", () => {
    it("adds component at the beginning", () => {
      const existing: Record<string, ComponentConfig> = {
        api: { type: "process", command: "dotnet run" },
      };
      const state = makeState({ config: { components: existing } });
      const next = wizardReducer(state, {
        type: "ADD_COMPONENT",
        payload: {
          key: "web",
          component: { type: "process", command: "npm run dev" },
        },
      });
      if (!next.config.components) throw new Error("expected componnts");
      const keys = Object.keys(next.config.components);
      expect(keys[0]).toBe("web");
      expect(keys[1]).toBe("api");
    });

    it("sets currentSubStep to the new component key and navigates to components section", () => {
      const state = makeState();
      const next = wizardReducer(state, {
        type: "ADD_COMPONENT",
        payload: {
          key: "server",
          component: { type: "process", command: "npm start" },
        },
      });
      expect(next.currentSubStep).toBe("server");
      expect(next.currentSection).toBe("components");
    });
  });

  describe("REMOVE_COMPONENT", () => {
    it("removes component and matching port", () => {
      const state = makeState({
        config: {
          components: {
            web: { type: "process", command: "npm run dev" },
            api: { type: "process", command: "dotnet run" },
          },
          ports: { web: { base: 3000 }, api: { base: 5000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "REMOVE_COMPONENT",
        payload: "web",
      });
      expect(next.config.components).not.toHaveProperty("web");
      expect(next.config.ports).not.toHaveProperty("web");
      expect(next.config.components).toHaveProperty("api");
      expect(next.config.ports).toHaveProperty("api");
    });

    it("resets currentSubStep to first remaining key when active sub-step is removed", () => {
      const state = makeState({
        currentSubStep: "web",
        config: {
          components: {
            web: { type: "process", command: "npm run dev" },
            api: { type: "process", command: "dotnet run" },
          },
          ports: { web: { base: 3000 }, api: { base: 5000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "REMOVE_COMPONENT",
        payload: "web",
      });
      expect(next.currentSubStep).not.toBe("web");
    });

    it("sets currentSubStep to null when last component is removed", () => {
      const state = makeState({
        currentSubStep: "web",
        config: {
          components: { web: { type: "process", command: "npm run dev" } },
          ports: { web: { base: 3000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "REMOVE_COMPONENT",
        payload: "web",
      });
      expect(next.currentSubStep).toBeNull();
    });

    it("leaves currentSubStep unchanged when a different component is removed", () => {
      const state = makeState({
        currentSubStep: "api",
        config: {
          components: {
            web: { type: "process", command: "npm run dev" },
            api: { type: "process", command: "dotnet run" },
          },
          ports: { web: { base: 3000 }, api: { base: 5000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "REMOVE_COMPONENT",
        payload: "web",
      });
      expect(next.currentSubStep).toBe("api");
    });
  });

  describe("UPDATE_COMPONENT", () => {
    it("updates specific component", () => {
      const state = makeState({
        config: {
          components: { web: { type: "process", command: "npm run dev" } },
        },
      });
      const next = wizardReducer(state, {
        type: "UPDATE_COMPONENT",
        payload: {
          key: "web",
          component: {
            type: "process",
            command: "npm run dev",
            directory: "./client",
          },
        },
      });
      if (!next.config.components) throw new Error("expected components");
      expect(next.config.components.web.directory).toBe("./client");
    });
  });

  describe("RENAME_COMPONENT", () => {
    it("renames component key and matching port key", () => {
      const state = makeState({
        config: {
          components: { old: { type: "process", command: "npm run dev" } },
          ports: { old: { base: 3000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "RENAME_COMPONENT",
        payload: { oldKey: "old", newKey: "new" },
      });
      expect(next.config.components).not.toHaveProperty("old");
      expect(next.config.components).toHaveProperty("new");
      if (!next.config.components) throw new Error("expected components");
      expect(next.config.components.new.type).toBe("process");
      expect(next.config.ports).not.toHaveProperty("old");
      expect(next.config.ports).toHaveProperty("new");
      if (!next.config.ports) throw new Error("expected ports");
      expect(next.config.ports.new.base).toBe(3000);
    });

    it("updates currentSubStep when the active component is renamed", () => {
      const state = makeState({
        currentSubStep: "old",
        config: {
          components: { old: { type: "process", command: "npm run dev" } },
          ports: { old: { base: 3000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "RENAME_COMPONENT",
        payload: { oldKey: "old", newKey: "new" },
      });
      expect(next.currentSubStep).toBe("new");
    });

    it("leaves currentSubStep unchanged when a different component is renamed", () => {
      const state = makeState({
        currentSubStep: "api",
        config: {
          components: {
            old: { type: "process", command: "npm run dev" },
            api: { type: "process", command: "dotnet run" },
          },
          ports: { old: { base: 3000 } },
        },
      });
      const next = wizardReducer(state, {
        type: "RENAME_COMPONENT",
        payload: { oldKey: "old", newKey: "new" },
      });
      expect(next.currentSubStep).toBe("api");
    });

    it("handles rename when port does not exist for old key", () => {
      const state = makeState({
        config: {
          components: { old: { type: "process", command: "npm run dev" } },
          ports: {},
        },
      });
      const next = wizardReducer(state, {
        type: "RENAME_COMPONENT",
        payload: { oldKey: "old", newKey: "new" },
      });
      expect(next.config.components).toHaveProperty("new");
      expect(next.config.ports).not.toHaveProperty("new");
    });
  });

  describe("SET_PORTS", () => {
    it("replaces ports entirely", () => {
      const ports: Record<string, PortConfig> = { web: { base: 4000 } };
      const state = makeState();
      const next = wizardReducer(state, { type: "SET_PORTS", payload: ports });
      expect(next.config.ports).toEqual(ports);
    });
  });

  describe("ADD_PORT", () => {
    it("adds a new port", () => {
      const state = makeState({ config: { ports: { web: { base: 3000 } } } });
      const next = wizardReducer(state, {
        type: "ADD_PORT",
        payload: { key: "api", port: { base: 5000 } },
      });
      expect(next.config.ports).toHaveProperty("api");
      if (!next.config.ports) throw new Error("expected ports");
      expect(next.config.ports.api.base).toBe(5000);
      expect(next.config.ports).toHaveProperty("web");
    });
  });

  describe("REMOVE_PORT", () => {
    it("removes a port", () => {
      const state = makeState({
        config: { ports: { web: { base: 3000 }, api: { base: 5000 } } },
      });
      const next = wizardReducer(state, {
        type: "REMOVE_PORT",
        payload: "web",
      });
      expect(next.config.ports).not.toHaveProperty("web");
      expect(next.config.ports).toHaveProperty("api");
    });
  });

  describe("UPDATE_PORT", () => {
    it("updates a port", () => {
      const state = makeState({ config: { ports: { web: { base: 3000 } } } });
      const next = wizardReducer(state, {
        type: "UPDATE_PORT",
        payload: { key: "web", port: { base: 4000 } },
      });
      if (!next.config.ports) throw new Error("expected ports");
      expect(next.config.ports.web.base).toBe(4000);
    });
  });

  describe("SET_TOOLS", () => {
    it("sets tools array", () => {
      const tools: ToolConfig[] = [
        {
          name: "Open Browser",
          icon: "globe",
          type: "browser",
          url: "http://localhost:3000",
        },
      ];
      const state = makeState();
      const next = wizardReducer(state, { type: "SET_TOOLS", payload: tools });
      expect(next.config.tools).toEqual(tools);
    });
  });

  describe("SET_USERS", () => {
    it("sets users array", () => {
      const users: UserConfig[] = [{ name: "Alice", properties: { role: "admin" } }];
      const state = makeState();
      const next = wizardReducer(state, { type: "SET_USERS", payload: users });
      expect(next.config.users).toEqual(users);
    });

    it("replaces existing users array", () => {
      const initial: UserConfig[] = [{ name: "Alice", properties: {} }];
      const updated: UserConfig[] = [{ name: "Bob", properties: { role: "member" } }];
      const state = makeState({ config: { users: initial } });
      const next = wizardReducer(state, {
        type: "SET_USERS",
        payload: updated,
      });
      expect(next.config.users).toEqual(updated);
    });

    it("physically removes users key from config when payload is empty", () => {
      const state = makeState({
        config: { users: [{ name: "Alice", properties: {} }] },
      });
      const next = wizardReducer(state, { type: "SET_USERS", payload: [] });
      expect("users" in next.config).toBe(false);
    });
  });

  describe("UPDATE_INSPECTION", () => {
    it("sets inspection config", () => {
      const inspection: InspectionConfig = {
        framework: "vitest",
        directory: ".",
        command: "npm test",
      };
      const state = makeState();
      const next = wizardReducer(state, {
        type: "UPDATE_INSPECTION",
        payload: inspection,
      });
      expect(next.config.inspection).toEqual(inspection);
    });

    it("clears inspection config when undefined", () => {
      const state = makeState({
        config: {
          inspection: { framework: "vitest", directory: ".", command: "test" },
        },
      });
      const next = wizardReducer(state, {
        type: "UPDATE_INSPECTION",
        payload: undefined,
      });
      expect(next.config.inspection).toBeUndefined();
    });
  });

  describe("UPDATE_BENCHES", () => {
    it("sets benches config", () => {
      const benches: BenchesConfig = { max: 10 };
      const state = makeState();
      const next = wizardReducer(state, {
        type: "UPDATE_BENCHES",
        payload: benches,
      });
      expect(next.config.benches).toEqual(benches);
    });
  });

  describe("SET_SECTION", () => {
    it("updates currentSection", () => {
      const state = makeState();
      const next = wizardReducer(state, {
        type: "SET_SECTION",
        payload: "components",
      });
      expect(next.currentSection).toBe("components");
    });

    it("resets currentSubStep to null", () => {
      const state = makeState({ currentSubStep: "server" });
      const next = wizardReducer(state, {
        type: "SET_SECTION",
        payload: "tools",
      });
      expect(next.currentSubStep).toBeNull();
    });
  });

  describe("SET_SECTION_AND_SUB_STEP", () => {
    it("sets both currentSection and currentSubStep atomically", () => {
      const state = makeState({
        currentSection: "project",
        currentSubStep: null,
      });
      const next = wizardReducer(state, {
        type: "SET_SECTION_AND_SUB_STEP",
        payload: { section: "components", subStep: "server" },
      });
      expect(next.currentSection).toBe("components");
      expect(next.currentSubStep).toBe("server");
    });
  });

  describe("SET_SUB_STEP", () => {
    it("sets currentSubStep", () => {
      const state = makeState();
      const next = wizardReducer(state, {
        type: "SET_SUB_STEP",
        payload: "server",
      });
      expect(next.currentSubStep).toBe("server");
    });

    it("clears currentSubStep when null", () => {
      const state = makeState({ currentSubStep: "server" });
      const next = wizardReducer(state, {
        type: "SET_SUB_STEP",
        payload: null,
      });
      expect(next.currentSubStep).toBeNull();
    });
  });

  describe("SET_SECTION_STATUS", () => {
    it("updates status for a specific section", () => {
      const state = makeState();
      const next = wizardReducer(state, {
        type: "SET_SECTION_STATUS",
        payload: { section: "project", status: "valid" },
      });
      expect(next.sectionStatus.project).toBe("valid");
      expect(next.sectionStatus.layout).toBe("pristine");
    });

    it("does not change review status", () => {
      const state = makeState({
        sectionStatus: {
          project: "valid",
          layout: "valid",
          components: "valid",
          tools: "valid",
          users: "valid",
          inspection: "valid",
          benches: "valid",
          review: "valid",
        },
      });
      const next = wizardReducer(state, {
        type: "SET_SECTION_STATUS",
        payload: { section: "benches", status: "invalid" },
      });
      // review is managed by SectionReview's useEffect, not the reducer
      expect(next.sectionStatus.review).toBe("valid");
    });
  });

  describe("config-modifying actions reset review to pristine", () => {
    const validStatus: Record<string, SectionStatus> = {
      project: "valid",
      layout: "valid",
      components: "valid",
      tools: "valid",
      users: "valid",
      inspection: "valid",
      benches: "valid",
      review: "valid",
    };

    it("UPDATE_BENCHES resets review to pristine", () => {
      const state = makeState({
        sectionStatus: validStatus as WizardState["sectionStatus"],
      });
      const next = wizardReducer(state, {
        type: "UPDATE_BENCHES",
        payload: { max: 3 },
      });
      expect(next.sectionStatus.review).toBe("pristine");
    });

    it("UPDATE_PROJECT resets review to pristine", () => {
      const state = makeState({
        sectionStatus: validStatus as WizardState["sectionStatus"],
      });
      const next = wizardReducer(state, {
        type: "UPDATE_PROJECT",
        payload: { name: "new-name" },
      });
      expect(next.sectionStatus.review).toBe("pristine");
    });

    it("ADD_COMPONENT resets review to pristine", () => {
      const state = makeState({
        sectionStatus: validStatus as WizardState["sectionStatus"],
      });
      const next = wizardReducer(state, {
        type: "ADD_COMPONENT",
        payload: {
          key: "db",
          component: { type: "process", command: "postgres" },
        },
      });
      expect(next.sectionStatus.review).toBe("pristine");
    });

    it("REMOVE_COMPONENT resets review to pristine", () => {
      const state = makeState({
        sectionStatus: validStatus as WizardState["sectionStatus"],
        config: {
          components: { web: { type: "process", command: "npm run dev" } },
        },
      });
      const next = wizardReducer(state, {
        type: "REMOVE_COMPONENT",
        payload: "web",
      });
      expect(next.sectionStatus.review).toBe("pristine");
    });

    it("SET_TOOLS resets review to pristine", () => {
      const state = makeState({
        sectionStatus: validStatus as WizardState["sectionStatus"],
      });
      const next = wizardReducer(state, { type: "SET_TOOLS", payload: [] });
      expect(next.sectionStatus.review).toBe("pristine");
    });

    it("SET_USERS resets review to pristine", () => {
      const state = makeState({
        sectionStatus: validStatus as WizardState["sectionStatus"],
      });
      const next = wizardReducer(state, { type: "SET_USERS", payload: [] });
      expect(next.sectionStatus.review).toBe("pristine");
    });
  });

  describe("SET_VALIDATION_ERRORS", () => {
    it("replaces validation errors", () => {
      const state = makeState();
      const errors = { "project.name": "required" };
      const next = wizardReducer(state, {
        type: "SET_VALIDATION_ERRORS",
        payload: errors,
      });
      expect(next.validationErrors).toEqual(errors);
    });
  });

  describe("SET_PORT_CONFLICTS", () => {
    it("replaces port conflicts", () => {
      const conflicts = [
        {
          port: "web",
          base: 3000,
          conflictsWith: {
            projectId: "x",
            projectName: "X",
            port: "api",
            range: [3000, 3004] as [number, number],
          },
        },
      ];
      const state = makeState();
      const next = wizardReducer(state, {
        type: "SET_PORT_CONFLICTS",
        payload: conflicts,
      });
      expect(next.portConflicts).toEqual(conflicts);
    });
  });

  describe("APPLY_SCAN_RESULT", () => {
    function makeScanResult(overrides?: Partial<RepoScanResult["detected"]>): RepoScanResult {
      return {
        detected: {
          hasGit: true,
          submodules: {},
          structureType: "single-repo",
          dockerComposeFiles: [],
          dockerComposeServiceNames: {},
          dockerComposePortVars: {},
          dockerComposeVars: {},
          dotnetProjects: [],
          solutionFiles: [],
          viteProjects: [],
          envFiles: [],
          webFrameworks: [],
          nativeFrameworks: [],
          suggestedName: "my-project",
          suggestedRepo: "https://github.com/org/my-project",
          suggestedProjectType: "web",
          suggestedComponents: [],
          suggestedTools: [],
          ...overrides,
        },
        existingConfig: null,
      };
    }

    it("sets project name from suggestedName when not already set", () => {
      const state = makeState();
      const scan = makeScanResult({ suggestedName: "detected-project" });
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      expect(next.config.project?.name).toBe("detected-project");
    });

    it("does NOT overwrite existing config.project.name", () => {
      const state = makeState({
        config: {
          project: {
            name: "custom",
            displayName: "Custom",
            type: "web",
            repo: "",
          },
        },
      });
      const scan = makeScanResult({ suggestedName: "detected-project" });
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      expect(next.config.project?.name).toBe("custom");
    });

    it("sets structure type from scan", () => {
      const state = makeState();
      const scan = makeScanResult({
        structureType: "meta-repo",
        submodules: { sub1: "url1" },
      });
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      expect(next.config.layout?.type).toBe("meta-repo");
      expect(next.config.layout?.submodules).toEqual({ sub1: "url1" });
    });

    it("populates components and ports from suggested components", () => {
      const state = makeState();
      const scan = makeScanResult({
        suggestedComponents: [
          {
            key: "web",
            config: { type: "process", command: "npm run dev" },
            source: "auto",
          },
          {
            key: "api",
            config: { type: "process", command: "dotnet run" },
            source: "auto",
          },
        ],
      });
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      expect(next.config.components).toHaveProperty("web");
      expect(next.config.components).toHaveProperty("api");
      expect(next.config.ports).toHaveProperty("web");
      expect(next.config.ports).toHaveProperty("api");
    });

    it("populates tools from suggested tools", () => {
      const state = makeState();
      const tool: ToolConfig = {
        name: "Open",
        icon: "globe",
        type: "browser",
        url: "http://localhost:3000",
      };
      const scan = makeScanResult({
        suggestedTools: [{ config: tool, source: "auto" }],
      });
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      expect(next.config.tools).toEqual([tool]);
    });

    it("delegates to LOAD_EXISTING_CONFIG when existingConfig present", () => {
      const state = makeState();
      const existingConfig: RouboConfig = {
        project: {
          name: "existing",
          displayName: "Existing",
          type: "web",
          repo: "",
        },
        layout: { type: "monorepo" },
        components: { web: { type: "process", command: "npm run dev" } },
        ports: { web: { base: 3000 } },
        benches: { max: 3 },
      };
      const scan: RepoScanResult = {
        ...makeScanResult(),
        existingConfig: { path: "/repo/roubo.yaml", config: existingConfig },
      };
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      // LOAD_EXISTING_CONFIG overwrites config with existing
      expect(next.config).toEqual(existingConfig);
      expect(next.isEditMode).toBe(true);
    });

    it("stores scanResult", () => {
      const state = makeState();
      const scan = makeScanResult();
      const next = wizardReducer(state, {
        type: "APPLY_SCAN_RESULT",
        payload: scan,
      });
      expect(next.scanResult).toEqual(scan);
    });
  });

  describe("LOAD_EXISTING_CONFIG", () => {
    it("sets all sections to valid when config is fully valid", () => {
      const state = makeState();
      const config: RouboConfig = {
        project: {
          name: "test",
          displayName: "Test",
          type: "web",
          repo: "org/repo",
        },
        layout: { type: "single-repo" },
        components: { web: { type: "process", command: "npm run dev" } },
        ports: { web: { base: 3000 } },
        benches: { max: 5 },
      };
      const next = wizardReducer(state, {
        type: "LOAD_EXISTING_CONFIG",
        payload: config,
      });
      for (const s of WIZARD_SECTIONS) {
        expect(next.sectionStatus[s]).toBe("valid");
      }
    });

    it("sets sections to invalid and review to invalid when config has incomplete components", () => {
      const state = makeState();
      const config: RouboConfig = {
        project: {
          name: "test",
          displayName: "Test",
          type: "web",
          repo: "org/repo",
        },
        layout: { type: "single-repo" },
        components: { web: { type: "process", command: "" } },
        ports: { web: { base: 3000 } },
        benches: { max: 5 },
      };
      const next = wizardReducer(state, {
        type: "LOAD_EXISTING_CONFIG",
        payload: config,
      });
      expect(next.sectionStatus.components).toBe("invalid");
      expect(next.sectionStatus.review).toBe("invalid");
    });

    it("sets isEditMode to true", () => {
      const state = makeState();
      const config: RouboConfig = {
        project: { name: "test", displayName: "Test", type: "web", repo: "" },
        layout: { type: "single-repo" },
        components: {},
        ports: {},
        benches: { max: 5 },
      };
      const next = wizardReducer(state, {
        type: "LOAD_EXISTING_CONFIG",
        payload: config,
      });
      expect(next.isEditMode).toBe(true);
    });

    it("replaces config with the provided config", () => {
      const state = makeState({
        config: { project: { name: "old" } as ProjectConfig },
      });
      const config: RouboConfig = {
        project: {
          name: "loaded",
          displayName: "Loaded",
          type: "api-only",
          repo: "git@...",
        },
        layout: { type: "monorepo" },
        components: { api: { type: "process", command: "dotnet run" } },
        ports: { api: { base: 5000 } },
        benches: { max: 3 },
      };
      const next = wizardReducer(state, {
        type: "LOAD_EXISTING_CONFIG",
        payload: config,
      });
      expect(next.config).toEqual(config);
    });

    it("validates users section as valid when users are present and well-formed", () => {
      const state = makeState();
      const config: RouboConfig = {
        project: {
          name: "test",
          displayName: "Test",
          type: "web",
          repo: "org/repo",
        },
        layout: { type: "single-repo" },
        components: { web: { type: "process", command: "npm run dev" } },
        ports: { web: { base: 3000 } },
        benches: { max: 5 },
        users: [{ name: "Alice", properties: { role: "admin" } }],
      };
      const next = wizardReducer(state, {
        type: "LOAD_EXISTING_CONFIG",
        payload: config,
      });
      expect(next.sectionStatus.users).toBe("valid");
    });
  });

  describe("MERGE_VALIDATION_ERRORS", () => {
    it("merges new errors into existing validationErrors", () => {
      const state = makeState({
        validationErrors: { "project.name": "Required" },
      });
      const next = wizardReducer(state, {
        type: "MERGE_VALIDATION_ERRORS",
        payload: { "benches.max": "Too large" },
      });
      expect(next.validationErrors).toEqual({
        "project.name": "Required",
        "benches.max": "Too large",
      });
    });

    it("overwrites existing key when merging with same key", () => {
      const state = makeState({
        validationErrors: { "project.name": "old error" },
      });
      const next = wizardReducer(state, {
        type: "MERGE_VALIDATION_ERRORS",
        payload: { "project.name": "new error" },
      });
      expect(next.validationErrors["project.name"]).toBe("new error");
    });
  });

  describe("MARK_TOUCHED", () => {
    it("adds a field key to touched", () => {
      const state = makeState();
      const next = wizardReducer(state, {
        type: "MARK_TOUCHED",
        payload: "project.name",
      });
      expect(next.touched["project.name"]).toBe(true);
    });

    it("returns same state reference when field is already touched", () => {
      const state = makeState({ touched: { "project.name": true } });
      const next = wizardReducer(state, {
        type: "MARK_TOUCHED",
        payload: "project.name",
      });
      expect(next).toBe(state);
    });
  });

  describe("default case", () => {
    it("returns state unchanged for unknown action type", () => {
      const state = makeState();
      const next = wizardReducer(state, {
        type: "NONEXISTENT_ACTION",
      } as unknown as WizardAction);
      expect(next).toBe(state);
    });
  });
});

import { isWizardSaveDisabled } from "./wizardReducer";

describe("isWizardSaveDisabled", () => {
  it("returns false when no errors, no conflicts, not saving", () => {
    const state = makeState({ validationErrors: {}, portConflicts: [] });
    expect(isWizardSaveDisabled(state, false)).toBe(false);
  });

  it("returns true when isSaving=true", () => {
    const state = makeState({ validationErrors: {}, portConflicts: [] });
    expect(isWizardSaveDisabled(state, true)).toBe(true);
  });

  it("returns true when validationErrors is non-empty", () => {
    const state = makeState({
      validationErrors: { "project.name": "Required" },
    });
    expect(isWizardSaveDisabled(state, false)).toBe(true);
  });

  it("returns true when portConflicts is non-empty", () => {
    const conflicts = [
      {
        port: "web",
        base: 3000,
        conflictsWith: {
          projectId: "x",
          projectName: "X",
          port: "api",
          range: [3000, 3004] as [number, number],
        },
      },
    ];
    const state = makeState({ validationErrors: {}, portConflicts: conflicts });
    expect(isWizardSaveDisabled(state, false)).toBe(true);
  });
});
