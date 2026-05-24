// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMenuNav } from "./useMenuNav";

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
