import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkForUpdate } from "./version-check.js";

function mockFetch(response: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(response),
  });
}

describe("checkForUpdate", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints update notice when a newer version is available", async () => {
    vi.stubGlobal("fetch", mockFetch({ version: "2.0.0" }));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Update available: 1.0.0 → 2.0.0. Run npm install -g roubo",
    );
  });

  it("prints nothing when on the latest version", async () => {
    vi.stubGlobal("fetch", mockFetch({ version: "1.0.0" }));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when current version is ahead of registry", async () => {
    vi.stubGlobal("fetch", mockFetch({ version: "0.9.0" }));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when fetch fails (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    await expect(checkForUpdate("1.0.0")).resolves.toBeUndefined();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
    );
    await expect(checkForUpdate("1.0.0")).resolves.toBeUndefined();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when response is not ok", async () => {
    vi.stubGlobal("fetch", mockFetch({}, false));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when version field is missing", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("detects minor version bumps", async () => {
    vi.stubGlobal("fetch", mockFetch({ version: "1.1.0" }));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Update available: 1.0.0 → 1.1.0. Run npm install -g roubo",
    );
  });

  it("detects patch version bumps", async () => {
    vi.stubGlobal("fetch", mockFetch({ version: "1.0.1" }));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Update available: 1.0.0 → 1.0.1. Run npm install -g roubo",
    );
  });

  it("prints nothing when registry returns a malformed version string", async () => {
    vi.stubGlobal("fetch", mockFetch({ version: "not-a-version" }));
    await checkForUpdate("1.0.0");
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
