import { describe, it, expect } from "vitest";
import { formatTimeAgo, formatLastUpdated, formatSnapshotAge } from "./last-updated";

const now = Date.parse("2024-06-01T12:00:00Z");

describe("formatTimeAgo", () => {
  it("collapses sub-minute gaps to 'just now'", () => {
    expect(formatTimeAgo(now - 5_000, now)).toBe("just now");
    expect(formatTimeAgo(now, now)).toBe("just now");
  });

  it("renders minutes, hours, and days", () => {
    expect(formatTimeAgo(now - 2 * 60_000, now)).toBe("2m ago");
    expect(formatTimeAgo(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(formatTimeAgo(now - 5 * 24 * 60 * 60_000, now)).toBe("5d ago");
  });

  it("clamps future timestamps to 'just now' rather than negative durations", () => {
    expect(formatTimeAgo(now + 10_000, now)).toBe("just now");
  });
});

describe("formatLastUpdated", () => {
  it("prefixes the warm label with 'updated'", () => {
    expect(formatLastUpdated(now - 2 * 60_000, now)).toBe("updated 2m ago");
    expect(formatLastUpdated(now, now)).toBe("updated just now");
  });

  it("returns null before the first successful fetch (epoch 0)", () => {
    expect(formatLastUpdated(0, now)).toBeNull();
  });
});

describe("formatSnapshotAge", () => {
  it("uses a distinct 'snapshot' wording, not 'updated'", () => {
    expect(formatSnapshotAge(now - 14 * 60_000, now)).toBe("snapshot 14m ago");
  });

  it("returns null when no timestamp is available", () => {
    expect(formatSnapshotAge(0, now)).toBeNull();
  });
});
