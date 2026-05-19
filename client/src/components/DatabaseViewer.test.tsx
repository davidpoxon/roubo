// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import DatabaseViewer from "./DatabaseViewer";
import type { UseQueryResult } from "@tanstack/react-query";
import type { DatabaseTable, DatabaseQueryResult, DatabaseTableSchema } from "@roubo/shared";

vi.mock("../hooks/useDatabase");
import { useDbTables, useDbTableData, useDbTableSchema } from "../hooks/useDatabase";

const mockedUseDbTables = vi.mocked(useDbTables);
const mockedUseDbTableData = vi.mocked(useDbTableData);
const mockedUseDbTableSchema = vi.mocked(useDbTableSchema);

function stubIdle() {
  mockedUseDbTableData.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as UseQueryResult<DatabaseQueryResult>);
  mockedUseDbTableSchema.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as UseQueryResult<DatabaseTableSchema>);
}

beforeEach(() => {
  vi.resetAllMocks();
  stubIdle();
});

const sampleTables: DatabaseTable[] = [
  { schema: "public", name: "users", type: "TABLE" as never, rowCount: 42 },
  { schema: "public", name: "v_summary", type: "VIEW" as never, rowCount: undefined },
];

const sampleTableData: DatabaseQueryResult = {
  rows: [{ id: 1, name: "Alice", score: null, meta: { key: "val" } }],
  columns: ["id", "name", "score", "meta"],
  totalRows: 1,
  page: 1,
  pageSize: 50,
};

const sampleSchema: DatabaseTableSchema = {
  columns: [
    {
      name: "id",
      dataType: "int",
      maxLength: null,
      isNullable: false,
      isPrimaryKey: true,
      isIdentity: true,
      defaultValue: null,
    },
    {
      name: "name",
      dataType: "varchar",
      maxLength: 255,
      isNullable: true,
      isPrimaryKey: false,
      isIdentity: false,
      defaultValue: "''",
    },
    {
      name: "bio",
      dataType: "varchar",
      maxLength: -1,
      isNullable: false,
      isPrimaryKey: false,
      isIdentity: false,
      defaultValue: null,
    },
  ],
  indexes: [
    { name: "pk_users", columns: ["id"], isPrimaryKey: true, isUnique: true, type: "CLUSTERED" },
    {
      name: "uq_name",
      columns: ["name"],
      isPrimaryKey: false,
      isUnique: true,
      type: "NONCLUSTERED",
    },
  ],
  foreignKeys: [
    { name: "fk_user", column: "user_id", referencedTable: "orders", referencedColumn: "id" },
  ],
};

describe("DatabaseViewer", () => {
  it("shows loading spinner while fetching tables", () => {
    mockedUseDbTables.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<DatabaseTable[]>);
    stubIdle();
    renderWithProviders(<DatabaseViewer projectId="a1" benchId={1} />);
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("shows error message when API call fails", () => {
    mockedUseDbTables.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("No database component configured"),
    } as unknown as UseQueryResult<DatabaseTable[]>);
    stubIdle();
    renderWithProviders(<DatabaseViewer projectId="a1" benchId={1} />);
    expect(screen.getByText("No database component configured")).toBeTruthy();
    expect(screen.queryByText("No tables found.")).toBeNull();
  });

  it('shows "No tables found." when query returns empty array', () => {
    mockedUseDbTables.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<DatabaseTable[]>);
    stubIdle();
    renderWithProviders(<DatabaseViewer projectId="a1" benchId={1} />);
    expect(screen.getByText("No tables found.")).toBeTruthy();
  });

  it("renders table names in sidebar when data is available", () => {
    mockedUseDbTables.mockReturnValue({
      data: [
        { schema: "dbo", name: "Users", type: "BASE TABLE" as const, rowCount: 42 },
        { schema: "dbo", name: "Orders", type: "BASE TABLE" as const, rowCount: 100 },
      ],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as UseQueryResult<DatabaseTable[]>);
    renderWithProviders(<DatabaseViewer projectId="a1" benchId={1} />);
    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByText("Orders")).toBeTruthy();
  });
});

describe("DatabaseViewer — data tab", () => {
  async function renderDataTab(overrides?: {
    tableData?: Partial<typeof sampleTableData> | null;
    isLoading?: boolean;
    isError?: boolean;
  }) {
    mockedUseDbTables.mockReturnValue({
      data: sampleTables,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    if (overrides?.isLoading) {
      mockedUseDbTableData.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
      } as never);
    } else if (overrides?.isError) {
      mockedUseDbTableData.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      } as never);
    } else if (overrides?.tableData !== undefined) {
      mockedUseDbTableData.mockReturnValue({
        data: overrides.tableData,
        isLoading: false,
        isError: false,
      } as never);
    }
    renderWithProviders(<DatabaseViewer projectId="p1" benchId={1} />);
    await userEvent.click(screen.getByText("users"));
  }

  it('shows "Select a table" prompt initially', () => {
    mockedUseDbTables.mockReturnValue({
      data: sampleTables,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    renderWithProviders(<DatabaseViewer projectId="p1" benchId={1} />);
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });

  it("shows data tab loading state after selecting table", async () => {
    await renderDataTab({ isLoading: true });
    expect(screen.getByText(/loading data/i)).toBeInTheDocument();
  });

  it("shows data tab error state", async () => {
    await renderDataTab({ isError: true });
    expect(screen.getByText(/failed to load table data/i)).toBeInTheDocument();
  });

  it('shows "No rows" when data is empty', async () => {
    await renderDataTab({
      tableData: { rows: [], columns: [], totalRows: 0, page: 1, pageSize: 50 },
    });
    expect(screen.getByText(/no rows/i)).toBeInTheDocument();
  });

  it("renders table data rows and handles null values", async () => {
    mockedUseDbTableData.mockReturnValue({
      data: sampleTableData,
      isLoading: false,
      isError: false,
    } as never);
    await renderDataTab({ tableData: sampleTableData });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toBeInTheDocument();
    expect(screen.getByText('{"key":"val"}')).toBeInTheDocument();
  });

  it("shows row count in pagination", async () => {
    await renderDataTab({ tableData: sampleTableData });
    expect(screen.getByText("rows")).toBeInTheDocument();
  });
});

describe("DatabaseViewer — schema tab", () => {
  async function renderSchemaTab(overrides?: { isLoading?: boolean; isError?: boolean }) {
    mockedUseDbTables.mockReturnValue({
      data: sampleTables,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    if (overrides?.isLoading) {
      mockedUseDbTableSchema.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
      } as never);
    } else if (overrides?.isError) {
      mockedUseDbTableSchema.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      } as never);
    } else {
      mockedUseDbTableSchema.mockReturnValue({
        data: sampleSchema,
        isLoading: false,
        isError: false,
      } as never);
    }
    renderWithProviders(<DatabaseViewer projectId="p1" benchId={1} />);
    await userEvent.click(screen.getByText("users"));
    await userEvent.click(screen.getByRole("button", { name: /schema/i }));
  }

  it("switches to schema tab and shows loading state", async () => {
    await renderSchemaTab({ isLoading: true });
    expect(screen.getByText(/loading schema/i)).toBeInTheDocument();
  });

  it("shows schema error state", async () => {
    await renderSchemaTab({ isError: true });
    expect(screen.getByText(/failed to load schema/i)).toBeInTheDocument();
  });

  it("renders schema columns with types", async () => {
    await renderSchemaTab();
    expect(screen.getByText("varchar(255)")).toBeInTheDocument();
    expect(screen.getByText("varchar(max)")).toBeInTheDocument();
  });

  it("shows NOT NULL badge for non-nullable columns", async () => {
    await renderSchemaTab();
    expect(screen.getAllByText("NOT NULL").length).toBeGreaterThan(0);
  });

  it("shows default value for columns with defaults", async () => {
    await renderSchemaTab();
    expect(screen.getByText(/= ''/)).toBeInTheDocument();
  });

  it("renders indexes section", async () => {
    await renderSchemaTab();
    expect(screen.getByText("pk_users")).toBeInTheDocument();
    expect(screen.getByText("uq_name")).toBeInTheDocument();
  });

  it("renders foreign keys section", async () => {
    await renderSchemaTab();
    expect(screen.getByText("fk_user")).toBeInTheDocument();
  });

  it("shows UNIQUE badge for unique non-PK indexes", async () => {
    await renderSchemaTab();
    expect(screen.getByText("UNIQUE")).toBeInTheDocument();
  });
});
