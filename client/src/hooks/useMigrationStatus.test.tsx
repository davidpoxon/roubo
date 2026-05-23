// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useMigrationStatus } from "./useMigrationStatus";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useMigrationStatus", () => {
  it("returns the parsed schemaVersion + migration record", async () => {
    const record = {
      schemaVersion: 1,
      migration: {
        status: "success" as const,
        at: "2026-05-23T10:00:00.000Z",
        migratedProjectIds: ["alpha"],
      },
    };
    mockedApi.fetchMigrationStatus.mockResolvedValue(record);

    const { result } = renderHookWithProviders(() => useMigrationStatus());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(record);
    expect(mockedApi.fetchMigrationStatus).toHaveBeenCalledTimes(1);
  });

  it("returns nulls when no migration has occurred", async () => {
    mockedApi.fetchMigrationStatus.mockResolvedValue({
      schemaVersion: null,
      migration: null,
    });

    const { result } = renderHookWithProviders(() => useMigrationStatus());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ schemaVersion: null, migration: null });
  });
});
