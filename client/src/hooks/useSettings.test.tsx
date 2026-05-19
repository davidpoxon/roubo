// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useSettings, useThemeSync } from "./useSettings";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

describe("useThemeSync", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    localStorage.clear();
  });

  it("applies dark theme class when theme is dark", async () => {
    mockedApi.fetchSettings.mockResolvedValue({
      theme: "dark",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });

    renderHookWithProviders(() => useThemeSync());
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));

    expect(localStorage.getItem("roubo-theme")).toBe("dark");
  });

  it("removes dark class when theme is light", async () => {
    document.documentElement.classList.add("dark");
    mockedApi.fetchSettings.mockResolvedValue({
      theme: "light",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });

    renderHookWithProviders(() => useThemeSync());
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));

    expect(localStorage.getItem("roubo-theme")).toBe("light");
  });

  it("registers and cleans up matchMedia listener when theme is system", async () => {
    const addEventListenerSpy = vi.fn();
    const removeEventListenerSpy = vi.fn();
    const mockMql = {
      matches: false,
      addEventListener: addEventListenerSpy,
      removeEventListener: removeEventListenerSpy,
    };
    vi.spyOn(window, "matchMedia").mockReturnValue(mockMql as unknown as MediaQueryList);

    mockedApi.fetchSettings.mockResolvedValue({
      theme: "system",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });

    const { unmount } = renderHookWithProviders(() => useThemeSync());
    await waitFor(() =>
      expect(addEventListenerSpy).toHaveBeenCalledWith("change", expect.any(Function)),
    );

    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith("change", expect.any(Function));
  });
});

describe("useSettings", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    localStorage.clear();
  });

  it("fetches settings", async () => {
    mockedApi.fetchSettings.mockResolvedValue({
      theme: "dark",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });

    const { result } = renderHookWithProviders(() => useSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings).toEqual({
      theme: "dark",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });
  });

  it("rolls back optimistic update and restores theme on error", async () => {
    mockedApi.fetchSettings.mockResolvedValue({
      theme: "dark",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });
    mockedApi.updateSettings.mockRejectedValue(new Error("Network error"));

    const { result } = renderHookWithProviders(() => useSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.updateSettings({ theme: "light" });
    });

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
  });

  it("calls updateSettings API and updates cache optimistically", async () => {
    mockedApi.fetchSettings.mockResolvedValue({
      theme: "dark",
      claudeCodeAutoModeAvailable: true,
      contextWindow: 200_000,
    });
    mockedApi.updateSettings.mockResolvedValue({ theme: "light" });

    const { result } = renderHookWithProviders(() => useSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.updateSettings({ theme: "light" });
    });

    await waitFor(() => expect(mockedApi.updateSettings).toHaveBeenCalledWith({ theme: "light" }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
  });
});
