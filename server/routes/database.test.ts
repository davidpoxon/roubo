import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/bench-manager.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/bench-manager.js")>();
  return {
    ...original,
    getBench: vi.fn(),
  };
});
vi.mock("../services/project-registry.js");
vi.mock("../services/config-parser.js");
vi.mock("../services/database.js");

import router from "./database.js";
import * as benchManager from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as configParser from "../services/config-parser.js";
import * as databaseService from "../services/database.js";
import type { RegisteredProject, RouboConfig, Bench } from "@roubo/shared";

const app = express();
app.use(express.json());
app.use("/", router);

const mockBench: Bench = {
  id: 1,
  projectId: "test-project",
  branch: "bench-1",
  workspacePath: "/workspaces/test-project/bench-1",
  status: "idle",
  ports: { app: 1433 },
  components: {},
  createdAt: "2024-01-01T00:00:00.000Z",
  provisioningSteps: [],
  teardownSteps: [],
  notifications: [],
};

const mockConfig: RouboConfig = {
  project: {
    name: "test-project",
    displayName: "Test Project",
    type: "web",
    repo: "git@github.com:test/test.git",
  },
  layout: { type: "single-repo" },
  components: {
    app: {
      type: "database",
      connection: {
        template: "Server=localhost,{{ports.app}};Database=TestDb;User Id=sa;Password=Test123;",
      },
    },
  },
  ports: { app: { base: 1433 } },
  benches: { max: 4 },
};

const mockProject: RegisteredProject = {
  id: "test-project",
  repoPath: "/repos/test-project",
  config: mockConfig,
  configValid: true,
};

beforeEach(() => {
  vi.mocked(benchManager.getBench).mockReturnValue(mockBench);
  vi.mocked(projectRegistry.getProject).mockReturnValue(mockProject);
  vi.mocked(configParser.buildTemplateContext).mockReturnValue({
    ports: { app: 1433 },
    portHttps: {},
    workspace: "/workspaces/test-project/bench-1",
    components: {},
  });
  vi.mocked(configParser.resolveTemplate).mockReturnValue(
    "Server=localhost,1433;Database=TestDb;User Id=sa;Password=Test123;",
  );
});

describe("invalid bench id", () => {
  it("returns 400 for non-numeric bench id", async () => {
    const res = await request(app).get("/test-project/benches/abc/database/tables");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

describe("GET /:projectId/benches/:id/database/tables", () => {
  it("returns 200 with tables", async () => {
    const tables = [
      { schema: "dbo", name: "Users", type: "BASE TABLE", rowCount: 42 },
      { schema: "dbo", name: "Orders", type: "BASE TABLE", rowCount: 100 },
    ];
    vi.mocked(databaseService.getTables).mockResolvedValue(tables as any);

    const res = await request(app).get("/test-project/benches/1/database/tables");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(tables);
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).get("/test-project/benches/99/database/tables");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 404 when project config not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/test-project/benches/1/database/tables");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROJECT_NOT_FOUND");
  });

  it("returns 400 when no database component configured", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...mockProject,
      config: {
        ...mockConfig,
        components: {
          frontend: { type: "process", command: "npm run dev" },
        },
      },
    });

    const res = await request(app).get("/test-project/benches/1/database/tables");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_DATABASE");
  });

  it("returns 500 on database error", async () => {
    vi.mocked(databaseService.getTables).mockRejectedValue(new Error("Connection refused"));

    const res = await request(app).get("/test-project/benches/1/database/tables");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Connection refused");
  });
});

describe("GET /:projectId/benches/:id/database/tables/:table/data", () => {
  it("returns 200 with table data using default params", async () => {
    const data = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "Alice" }],
      totalRows: 1,
      page: 1,
      pageSize: 50,
    };
    vi.mocked(databaseService.getTableData).mockResolvedValue(data);

    const res = await request(app).get("/test-project/benches/1/database/tables/Users/data");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(data);
    expect(databaseService.getTableData).toHaveBeenCalledWith(
      expect.any(String),
      "dbo",
      "Users",
      1,
      50,
    );
  });

  it("passes custom page, pageSize, and schema query params", async () => {
    vi.mocked(databaseService.getTableData).mockResolvedValue({
      columns: [],
      rows: [],
      totalRows: 0,
      page: 3,
      pageSize: 10,
    });

    const res = await request(app).get(
      "/test-project/benches/1/database/tables/Orders/data?page=3&pageSize=10&schema=sales",
    );

    expect(res.status).toBe(200);
    expect(databaseService.getTableData).toHaveBeenCalledWith(
      expect.any(String),
      "sales",
      "Orders",
      3,
      10,
    );
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).get("/test-project/benches/99/database/tables/Users/data");

    expect(res.status).toBe(404);
  });

  it("clamps page=0 to 1", async () => {
    vi.mocked(databaseService.getTableData).mockResolvedValue({
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 50,
    });

    await request(app).get("/test-project/benches/1/database/tables/Users/data?page=0");

    expect(databaseService.getTableData).toHaveBeenCalledWith(
      expect.any(String),
      "dbo",
      "Users",
      1,
      50,
    );
  });

  it("clamps negative page to 1", async () => {
    vi.mocked(databaseService.getTableData).mockResolvedValue({
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 50,
    });

    await request(app).get("/test-project/benches/1/database/tables/Users/data?page=-5");

    expect(databaseService.getTableData).toHaveBeenCalledWith(
      expect.any(String),
      "dbo",
      "Users",
      1,
      50,
    );
  });

  it("caps pageSize at 500", async () => {
    vi.mocked(databaseService.getTableData).mockResolvedValue({
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 500,
    });

    await request(app).get("/test-project/benches/1/database/tables/Users/data?pageSize=9999");

    expect(databaseService.getTableData).toHaveBeenCalledWith(
      expect.any(String),
      "dbo",
      "Users",
      1,
      500,
    );
  });

  it("clamps negative pageSize to 1", async () => {
    vi.mocked(databaseService.getTableData).mockResolvedValue({
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 1,
    });

    await request(app).get("/test-project/benches/1/database/tables/Users/data?pageSize=-10");

    expect(databaseService.getTableData).toHaveBeenCalledWith(
      expect.any(String),
      "dbo",
      "Users",
      1,
      1,
    );
  });
});

describe("GET /:projectId/benches/:id/database/tables/:table/schema", () => {
  it("returns 200 with table schema using default dbo", async () => {
    const tableSchema = {
      columns: [
        {
          name: "Id",
          dataType: "int",
          maxLength: null,
          isNullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isIdentity: true,
        },
      ],
      indexes: [
        {
          name: "PK_Users",
          columns: ["Id"],
          isUnique: true,
          isPrimaryKey: true,
          type: "CLUSTERED",
        },
      ],
      foreignKeys: [],
    };
    vi.mocked(databaseService.getTableSchema).mockResolvedValue(tableSchema);

    const res = await request(app).get("/test-project/benches/1/database/tables/Users/schema");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(tableSchema);
    expect(databaseService.getTableSchema).toHaveBeenCalledWith(expect.any(String), "dbo", "Users");
  });

  it("passes custom schema query param", async () => {
    vi.mocked(databaseService.getTableSchema).mockResolvedValue({
      columns: [],
      indexes: [],
      foreignKeys: [],
    });

    const res = await request(app).get(
      "/test-project/benches/1/database/tables/Orders/schema?schema=sales",
    );

    expect(res.status).toBe(200);
    expect(databaseService.getTableSchema).toHaveBeenCalledWith(
      expect.any(String),
      "sales",
      "Orders",
    );
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).get("/test-project/benches/99/database/tables/Users/schema");

    expect(res.status).toBe(404);
  });

  it("returns 400 when no database component configured", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      ...mockProject,
      config: {
        ...mockConfig,
        components: {
          backend: { type: "process", command: "dotnet run" },
        },
      },
    });

    const res = await request(app).get("/test-project/benches/1/database/tables/Users/schema");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_DATABASE");
  });
});

describe("connection string resolution with assigned containers", () => {
  it("overrides ports from assigned containers", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      ...mockBench,
      assignedContainers: {
        app: { containerId: "abc123", containerName: "my-db", port: 9999 },
      },
    });
    vi.mocked(databaseService.getTables).mockResolvedValue([]);

    const res = await request(app).get("/test-project/benches/1/database/tables");

    expect(res.status).toBe(200);
    expect(configParser.buildTemplateContext).toHaveBeenCalled();
  });
});
