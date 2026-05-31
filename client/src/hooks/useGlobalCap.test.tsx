// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Bench, SettingsResponse } from "@roubo/shared";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useGlobalCap } from "./useGlobalCap";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

function makeSettings(maxGlobal?: number): SettingsResponse {
  return {
    theme: "dark",
    claudeCodeAutoModeAvailable: true,
    contextWindow: 200_000,
    benches: maxGlobal === undefined ? undefined : ({ maxGlobal } as SettingsResponse["benches"]),
  } as SettingsResponse;
}

function makeBenches(count: number): Bench[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1 }) as Bench);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useGlobalCap", () => {
  it("reports unlimited when no cap is set", async () => {
    mockedApi.fetchSettings.mockResolvedValue(makeSettings(undefined));
    mockedApi.fetchAllBenches.mockResolvedValue(makeBenches(3));

    const { result } = renderHookWithProviders(() => useGlobalCap());

    await waitFor(() => expect(result.current.current).toBe(3));
    expect(result.current).toMatchObject({
      max: null,
      isCapped: false,
      isAtCap: false,
      isOverCap: false,
    });
  });

  it("is below cap when current is under max", async () => {
    mockedApi.fetchSettings.mockResolvedValue(makeSettings(2));
    mockedApi.fetchAllBenches.mockResolvedValue(makeBenches(1));

    const { result } = renderHookWithProviders(() => useGlobalCap());

    await waitFor(() => expect(result.current.max).toBe(2));
    expect(result.current).toMatchObject({
      current: 1,
      isCapped: true,
      isAtCap: false,
      isOverCap: false,
    });
  });

  it("is at cap when current equals max", async () => {
    mockedApi.fetchSettings.mockResolvedValue(makeSettings(2));
    mockedApi.fetchAllBenches.mockResolvedValue(makeBenches(2));

    const { result } = renderHookWithProviders(() => useGlobalCap());

    await waitFor(() => expect(result.current.isAtCap).toBe(true));
    expect(result.current).toMatchObject({
      current: 2,
      max: 2,
      isCapped: true,
      isOverCap: false,
    });
  });

  it("is over cap when current exceeds max", async () => {
    mockedApi.fetchSettings.mockResolvedValue(makeSettings(2));
    mockedApi.fetchAllBenches.mockResolvedValue(makeBenches(3));

    const { result } = renderHookWithProviders(() => useGlobalCap());

    await waitFor(() => expect(result.current.isOverCap).toBe(true));
    expect(result.current).toMatchObject({
      current: 3,
      max: 2,
      isCapped: true,
      isAtCap: true,
    });
  });
});
