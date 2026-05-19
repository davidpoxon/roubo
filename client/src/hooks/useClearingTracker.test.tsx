// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  TeardownTrackerContext,
  type TeardownTrackerContextValue,
} from "../lib/teardown-tracker-context";
import { useTeardownTracker } from "./useClearingTracker";

describe("useTeardownTracker", () => {
  it("throws when used outside TeardownTrackerProvider", () => {
    expect(() => renderHook(() => useTeardownTracker())).toThrow(
      "useTeardownTracker must be used within TeardownTrackerProvider",
    );
  });

  it("returns context value when inside TeardownTrackerContext.Provider", () => {
    const mockValue: TeardownTrackerContextValue = {
      teardowns: new Map(),
      register: () => {},
    };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TeardownTrackerContext.Provider value={mockValue}>
        {children}
      </TeardownTrackerContext.Provider>
    );
    const { result } = renderHook(() => useTeardownTracker(), { wrapper });
    expect(result.current).toBe(mockValue);
    expect(result.current.teardowns).toBeInstanceOf(Map);
    expect(typeof result.current.register).toBe("function");
  });
});
