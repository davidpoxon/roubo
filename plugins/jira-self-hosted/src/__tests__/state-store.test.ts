import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetCacheForTests, getLastPoll, setLastPoll } from "../state-store.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

describe("state-store (TC-030 watermark persistence)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
    _resetCacheForTests();
  });
  afterEach(() => {
    harness.dispose();
    _resetCacheForTests();
  });

  it("returns null before the first write", async () => {
    expect(await getLastPoll("board-1")).toBeNull();
  });

  it("round-trips a timestamp via the host credentials slot", async () => {
    await setLastPoll("board-1", "2026-04-01T00:00:00Z");
    expect(await getLastPoll("board-1")).toBe("2026-04-01T00:00:00Z");
    // The stored blob is the JSON map.
    expect(harness.credentials.get("state")).toBe('{"board-1":"2026-04-01T00:00:00Z"}');
  });

  it("keeps timestamps for different sources independent", async () => {
    await setLastPoll("board-1", "2026-04-01T00:00:00Z");
    await setLastPoll("filter-9", "2026-05-01T00:00:00Z");
    expect(await getLastPoll("board-1")).toBe("2026-04-01T00:00:00Z");
    expect(await getLastPoll("filter-9")).toBe("2026-05-01T00:00:00Z");
  });

  it("recovers gracefully from a corrupted slot blob", async () => {
    harness.credentials.set("state", "not-json");
    _resetCacheForTests();
    expect(await getLastPoll("board-1")).toBeNull();
    await setLastPoll("board-1", "2026-04-01T00:00:00Z");
    expect(await getLastPoll("board-1")).toBe("2026-04-01T00:00:00Z");
  });
});
