// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useDbTables, useDbTableData, useDbTableSchema } from "./useDatabase";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useDbTables", () => {
  it("fetches tables for the bench", async () => {
    const tables = [{ schema: "dbo", name: "Users", type: "BASE TABLE" as const, rowCount: 42 }];
    mockedApi.fetchDbTables.mockResolvedValue(tables);
    const { result } = renderHookWithProviders(() => useDbTables("a1", 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchDbTables).toHaveBeenCalledWith("a1", 1);
    expect(result.current.data).toEqual(tables);
  });
});

describe("useDbTableData", () => {
  it("fetches paginated table data", async () => {
    const data = {
      columns: ["id", "name"],
      rows: [{ id: 1, name: "test" }],
      totalRows: 1,
      page: 1,
      pageSize: 50,
    };
    mockedApi.fetchDbTableData.mockResolvedValue(data);
    const { result } = renderHookWithProviders(() =>
      useDbTableData("a1", 1, "dbo", "Users", 1, 50),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchDbTableData).toHaveBeenCalledWith("a1", 1, "dbo", "Users", 1, 50);
    expect(result.current.data).toEqual(data);
  });

  it("does not fetch when table is empty", () => {
    renderHookWithProviders(() => useDbTableData("a1", 1, "dbo", "", 1, 50));
    expect(mockedApi.fetchDbTableData).not.toHaveBeenCalled();
  });
});

describe("useDbTableSchema", () => {
  it("fetches table schema", async () => {
    const schema = { columns: [], indexes: [], foreignKeys: [] };
    mockedApi.fetchDbTableSchema.mockResolvedValue(schema);
    const { result } = renderHookWithProviders(() => useDbTableSchema("a1", 1, "dbo", "Users"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchDbTableSchema).toHaveBeenCalledWith("a1", 1, "dbo", "Users");
    expect(result.current.data).toEqual(schema);
  });
});
