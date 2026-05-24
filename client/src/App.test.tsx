// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMenuNav, useDeepLink } from "./App";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await import("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

describe("useMenuNav", () => {
  let fireNavigate: (path: string) => void;

  beforeEach(() => {
    mockNavigate.mockClear();
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        onNavigate: vi.fn((cb: (path: string) => void) => {
          fireNavigate = cb;
          return () => {};
        }),
        onDeepLink: vi.fn(() => () => {}),
        platform: "darwin",
        setTitleBarOverlayTheme: vi.fn(),
        getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: undefined,
    });
  });

  it("navigates to /settings when allowlisted path is received", () => {
    renderHook(() => useMenuNav());
    act(() => fireNavigate("/settings"));
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("navigates to /updates when allowlisted path is received", () => {
    renderHook(() => useMenuNav());
    act(() => fireNavigate("/updates"));
    expect(mockNavigate).toHaveBeenCalledWith("/updates");
  });

  it("does not navigate for non-allowlisted paths", () => {
    renderHook(() => useMenuNav());
    act(() => {
      fireNavigate("/");
      fireNavigate("/projects/foo");
      fireNavigate("/projects/foo/benches/bar");
      fireNavigate("/not-a-real-path");
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does nothing when window.roubo is undefined", () => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: undefined,
    });
    expect(() => renderHook(() => useMenuNav())).not.toThrow();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("useDeepLink", () => {
  let fireDeepLink: (url: string) => void;
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.fn>;

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    mockNavigate.mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidateSpy = vi.fn();
    queryClient.invalidateQueries = invalidateSpy as never;
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        onNavigate: vi.fn(() => () => {}),
        onDeepLink: vi.fn((cb: (url: string) => void) => {
          fireDeepLink = cb;
          return () => {};
        }),
        platform: "darwin",
        setTitleBarOverlayTheme: vi.fn(),
        getAppVersion: vi.fn().mockResolvedValue("1.0.0"),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: undefined,
    });
  });

  it("navigates to the bench route for project deep links", () => {
    renderHook(() => useDeepLink(), { wrapper });
    act(() => fireDeepLink("roubo://project/proj-1/bench/bench-2"));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-1/benches/bench-2");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates integration React Query caches when the GitHub OAuth callback arrives", () => {
    renderHook(() => useDeepLink(), { wrapper });
    act(() => fireDeepLink("roubo://oauth/github/callback?code=abc&state=xyz"));
    expect(mockNavigate).not.toHaveBeenCalled();
    const keys = invalidateSpy.mock.calls.map((args) => args[0]?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["global-plugin-integration", "github-com"],
        ["project-integration"],
        ["source-candidates"],
      ]),
    );
  });

  it("ignores non-roubo URLs", () => {
    renderHook(() => useDeepLink(), { wrapper });
    act(() => fireDeepLink("https://example.com/foo"));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores malformed URLs without throwing", () => {
    renderHook(() => useDeepLink(), { wrapper });
    expect(() => act(() => fireDeepLink("not a url"))).not.toThrow();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
