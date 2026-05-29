import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockInput = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockConnected = vi.hoisted(() => ({ value: false }));

vi.mock("mssql", () => {
  const request = () => {
    const req = {
      query: mockQuery,
      input: mockInput,
    };
    mockInput.mockReturnValue(req);
    return req;
  };

  class MockConnectionPool {
    get connected() {
      return mockConnected.value;
    }
    connect = mockConnect;
    close = mockClose;
    request = request;
  }

  return {
    default: {
      ConnectionPool: MockConnectionPool,
      Int: "Int",
      NVarChar: "NVarChar",
    },
  };
});

import {
  getTables,
  getTableData,
  getTableSchema,
  closeIdleConnections,
  closeAllConnections,
} from "./database.js";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  mockQuery.mockReset();
  mockInput.mockReset();
  mockConnect.mockReset();
  mockClose.mockReset();
  mockConnected.value = false;
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  // Clear any pools left by previous tests
  await closeAllConnections();
  mockClose.mockClear();
});

describe("getTables", () => {
  it("returns correctly shaped table data", async () => {
    mockQuery.mockResolvedValue({
      recordset: [
        { schema: "dbo", name: "Users", type: "BASE TABLE", rowCount: 42 },
        { schema: "dbo", name: "Orders", type: "BASE TABLE", rowCount: 100 },
        { schema: "dbo", name: "UserView", type: "VIEW", rowCount: null },
      ],
    });

    const tables = await getTables("Server=localhost;Database=test");

    expect(tables).toEqual([
      { schema: "dbo", name: "Users", type: "BASE TABLE", rowCount: 42 },
      { schema: "dbo", name: "Orders", type: "BASE TABLE", rowCount: 100 },
      { schema: "dbo", name: "UserView", type: "VIEW", rowCount: undefined },
    ]);
  });

  it("returns empty array when no tables", async () => {
    mockQuery.mockResolvedValue({ recordset: [] });

    const tables = await getTables("Server=localhost;Database=test");

    expect(tables).toEqual([]);
  });
});

describe("getTableData", () => {
  it("returns paginated data with correct shape", async () => {
    mockQuery.mockResolvedValue({
      recordset: [
        { id: 1, name: "Alice", __total_count: 50 },
        { id: 2, name: "Bob", __total_count: 50 },
      ],
    });

    const result = await getTableData("Server=localhost;Database=test", "dbo", "Users", 1, 25);

    expect(result).toEqual({
      columns: ["id", "name"],
      rows: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
      totalRows: 50,
      page: 1,
      pageSize: 25,
    });
  });

  it("passes correct offset for page 2", async () => {
    mockQuery.mockResolvedValue({
      recordset: [{ id: 26, name: "Zara", __total_count: 50 }],
    });

    const result = await getTableData("Server=localhost;Database=test", "dbo", "Users", 2, 25);

    expect(mockInput).toHaveBeenCalledWith("offset", "Int", 25);
    expect(mockInput).toHaveBeenCalledWith("pageSize", "Int", 25);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(25);
  });

  it("returns empty result when no rows", async () => {
    mockQuery.mockResolvedValue({ recordset: [] });

    const result = await getTableData("Server=localhost;Database=test", "dbo", "Empty", 1, 25);

    expect(result).toEqual({
      columns: [],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 25,
    });
  });
});

describe("getTableSchema", () => {
  it("returns columns, indexes, and foreign keys", async () => {
    // First call: columns
    mockQuery
      .mockResolvedValueOnce({
        recordset: [
          {
            name: "Id",
            dataType: "int",
            maxLength: null,
            isNullable: 0,
            defaultValue: null,
            isPrimaryKey: 1,
            isIdentity: 1,
          },
          {
            name: "Name",
            dataType: "nvarchar",
            maxLength: 255,
            isNullable: 1,
            defaultValue: null,
            isPrimaryKey: 0,
            isIdentity: 0,
          },
        ],
      })
      // Second call: indexes
      .mockResolvedValueOnce({
        recordset: [
          {
            name: "PK_Users",
            columnName: "Id",
            isUnique: 1,
            isPrimaryKey: 1,
            type: "CLUSTERED",
          },
          {
            name: "IX_Users_Name",
            columnName: "Name",
            isUnique: 0,
            isPrimaryKey: 0,
            type: "NONCLUSTERED",
          },
        ],
      })
      // Third call: foreign keys
      .mockResolvedValueOnce({
        recordset: [
          {
            name: "FK_Users_RoleId",
            column: "RoleId",
            referencedTable: "Roles",
            referencedColumn: "Id",
          },
        ],
      });

    const schema = await getTableSchema("Server=localhost;Database=test", "dbo", "Users");

    expect(schema.columns).toEqual([
      {
        name: "Id",
        dataType: "int",
        maxLength: null,
        isNullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isIdentity: true,
      },
      {
        name: "Name",
        dataType: "nvarchar",
        maxLength: 255,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isIdentity: false,
      },
    ]);

    expect(schema.indexes).toEqual([
      {
        name: "PK_Users",
        columns: ["Id"],
        isUnique: true,
        isPrimaryKey: true,
        type: "CLUSTERED",
      },
      {
        name: "IX_Users_Name",
        columns: ["Name"],
        isUnique: false,
        isPrimaryKey: false,
        type: "NONCLUSTERED",
      },
    ]);

    expect(schema.foreignKeys).toEqual([
      {
        name: "FK_Users_RoleId",
        column: "RoleId",
        referencedTable: "Roles",
        referencedColumn: "Id",
      },
    ]);
  });

  it("groups multi-column indexes", async () => {
    mockQuery
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({
        recordset: [
          {
            name: "IX_Composite",
            columnName: "Col1",
            isUnique: 1,
            isPrimaryKey: 0,
            type: "NONCLUSTERED",
          },
          {
            name: "IX_Composite",
            columnName: "Col2",
            isUnique: 1,
            isPrimaryKey: 0,
            type: "NONCLUSTERED",
          },
        ],
      })
      .mockResolvedValueOnce({ recordset: [] });

    const schema = await getTableSchema("Server=localhost;Database=test", "dbo", "Users");

    expect(schema.indexes).toEqual([
      {
        name: "IX_Composite",
        columns: ["Col1", "Col2"],
        isUnique: true,
        isPrimaryKey: false,
        type: "NONCLUSTERED",
      },
    ]);
  });
});

describe("connection caching", () => {
  it("reuses existing connected pool", async () => {
    mockQuery.mockResolvedValue({ recordset: [] });

    await getTables("Server=localhost;Database=cache-test");

    // Now mark pool as connected for second call
    mockConnected.value = true;
    await getTables("Server=localhost;Database=cache-test");

    // connect() should only be called once
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

describe("closeIdleConnections", () => {
  it("does not close pools that have been used recently", async () => {
    mockQuery.mockResolvedValue({ recordset: [] });

    await getTables("Server=localhost;Database=idle-test");
    await closeIdleConnections();

    expect(mockClose).not.toHaveBeenCalled();
  });

  it("closes pools that have been idle longer than timeout", async () => {
    vi.useFakeTimers();
    try {
      mockQuery.mockResolvedValue({ recordset: [] });

      await getTables("Server=localhost;Database=idle-test-2");

      // Advance time past the 60s idle timeout
      vi.advanceTimersByTime(61_000);

      await closeIdleConnections();

      expect(mockClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("closeAllConnections", () => {
  it("closes all pools regardless of idle time", async () => {
    mockQuery.mockResolvedValue({ recordset: [] });

    await getTables("Server=localhost;Database=all-test-1");
    await getTables("Server=localhost;Database=all-test-2");

    await closeAllConnections();

    expect(mockClose).toHaveBeenCalledTimes(2);
  });
});
