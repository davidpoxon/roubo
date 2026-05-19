// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { ToastContext, type ToastContextValue } from "../lib/toast-context";
import { useToast } from "./useToast";

describe("useToast", () => {
  it("throws when used outside a ToastProvider", () => {
    expect(() => renderHook(() => useToast())).toThrow(
      "useToast must be used within a ToastProvider",
    );
  });

  it("returns context value when inside ToastContext.Provider", () => {
    const mockValue: ToastContextValue = {
      addToast: () => "id-1",
      removeToast: () => {},
    };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastContext.Provider value={mockValue}>{children}</ToastContext.Provider>
    );
    const { result } = renderHook(() => useToast(), { wrapper });
    expect(result.current).toBe(mockValue);
    expect(typeof result.current.addToast).toBe("function");
    expect(typeof result.current.removeToast).toBe("function");
  });
});
