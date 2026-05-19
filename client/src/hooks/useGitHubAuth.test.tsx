// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useGitHubAuth, useConnectGitHub, useDisconnectGitHub } from "./useGitHubAuth";

vi.mock("../lib/api");
import * as api from "../lib/api";

const mockedApi = vi.mocked(api);

describe("useGitHubAuth", () => {
  it("returns connected: false when not connected", async () => {
    mockedApi.fetchGitHubAuthStatus.mockResolvedValue({ connected: false });

    const { result } = renderHookWithProviders(() => useGitHubAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.status).toEqual({ connected: false });
  });

  it("returns connected: true with username when connected", async () => {
    mockedApi.fetchGitHubAuthStatus.mockResolvedValue({
      connected: true,
      username: "testuser",
      scopes: ["repo", "read:org"],
    });

    const { result } = renderHookWithProviders(() => useGitHubAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.status?.connected).toBe(true);
    expect(result.current.status?.username).toBe("testuser");
  });

  it("exposes an error when the fetch fails", async () => {
    mockedApi.fetchGitHubAuthStatus.mockRejectedValue(new Error("Network error"));

    const { result } = renderHookWithProviders(() => useGitHubAuth());
    await waitFor(() => expect(result.current.error).toBeTruthy());

    expect((result.current.error as Error).message).toBe("Network error");
  });
});

describe("useConnectGitHub", () => {
  beforeEach(() => {
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("fetches the auth URL and opens it in a new tab", async () => {
    mockedApi.fetchGitHubAuthUrl.mockResolvedValue({
      url: "https://github.com/login/oauth/authorize?client_id=test&state=abc",
    });

    const { result } = renderHookWithProviders(() => useConnectGitHub());

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?client_id=test&state=abc",
        "_blank",
        "noopener,noreferrer",
      ),
    );
  });
});

describe("useDisconnectGitHub", () => {
  it("calls disconnectGitHub API and resolves", async () => {
    mockedApi.disconnectGitHub.mockResolvedValue(undefined);
    mockedApi.fetchGitHubAuthStatus.mockResolvedValue({ connected: false });

    const { result } = renderHookWithProviders(() => useDisconnectGitHub());

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.disconnectGitHub).toHaveBeenCalled();
  });

  it("exposes isError when disconnectGitHub API rejects", async () => {
    mockedApi.disconnectGitHub.mockRejectedValue(new Error("EPERM"));

    const { result } = renderHookWithProviders(() => useDisconnectGitHub());

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
