// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeepLink } from "./useDeepLink";

const mockNavigate = vi.fn();
vi.mock("react-router", async () => {
  const actual = await import("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

describe("useDeepLink", () => {
  let fireDeepLink: (url: string) => void;

  beforeEach(() => {
    mockNavigate.mockClear();
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
    renderHook(() => useDeepLink());
    act(() => fireDeepLink("roubo://project/proj-1/bench/bench-2"));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-1/benches/bench-2");
  });

  it("ignores a GitHub OAuth callback: sign-in uses the device flow (#1457)", () => {
    renderHook(() => useDeepLink());
    expect(() =>
      act(() => fireDeepLink("roubo://oauth/github/callback?code=abc&state=xyz")),
    ).not.toThrow();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("ignores non-roubo URLs", () => {
    renderHook(() => useDeepLink());
    act(() => fireDeepLink("https://example.com/foo"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("ignores malformed URLs without throwing", () => {
    renderHook(() => useDeepLink());
    expect(() => act(() => fireDeepLink("not a url"))).not.toThrow();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
