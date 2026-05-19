import { describe, it, expect } from "vitest";
import { computeRefetchInterval } from "./useGitHubAuth";

describe("computeRefetchInterval", () => {
  it("returns false when polling is not set", () => {
    expect(computeRefetchInterval(undefined, false)).toBe(false);
    expect(computeRefetchInterval(undefined, true)).toBe(false);
    expect(computeRefetchInterval(undefined, undefined)).toBe(false);
  });

  it("returns false when polling is false", () => {
    expect(computeRefetchInterval(false, false)).toBe(false);
    expect(computeRefetchInterval(false, true)).toBe(false);
  });

  it("returns 2000 when polling is true and not yet connected", () => {
    expect(computeRefetchInterval(true, false)).toBe(2000);
  });

  it("returns 2000 when polling is true and status is not yet loaded", () => {
    expect(computeRefetchInterval(true, undefined)).toBe(2000);
  });

  it("returns false when polling is true but already connected", () => {
    expect(computeRefetchInterval(true, true)).toBe(false);
  });
});
