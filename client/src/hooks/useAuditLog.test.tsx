// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import type { AuditEntry } from "@roubo/shared";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useAuditLog } from "./useAuditLog";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

const entries: AuditEntry[] = [
  {
    ts: "2026-06-21T00:00:00.000Z",
    pluginId: "github-com",
    benchId: 1,
    method: "host.process.start",
    params: {},
    outcome: "allowed",
  },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useAuditLog", () => {
  it("fetches the bench audit log", async () => {
    mockedApi.fetchAuditLog.mockResolvedValue(entries);
    const { result } = renderHookWithProviders(() => useAuditLog("p1", 1));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchAuditLog).toHaveBeenCalledWith("p1", 1, undefined);
    expect(result.current.data).toEqual(entries);
  });

  it("passes the pluginId filter through", async () => {
    mockedApi.fetchAuditLog.mockResolvedValue(entries);
    const { result } = renderHookWithProviders(() => useAuditLog("p1", 1, "github-com"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.fetchAuditLog).toHaveBeenCalledWith("p1", 1, "github-com");
  });
});
