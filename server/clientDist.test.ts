import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

import { existsSync } from "node:fs";
import { resolveClientDist } from "./clientDist.js";

const mockExistsSync = vi.mocked(existsSync);

describe("resolveClientDist", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  it("dev mode: package.json present at dirname, resolves ../client/dist", () => {
    mockExistsSync.mockReturnValue(true);
    const result = resolveClientDist("/repo/server");
    expect(result).toBe(path.join("/repo/server", "..", "client", "dist"));
  });

  it("compiled mode: no package.json at dirname, goes up one level", () => {
    mockExistsSync.mockReturnValue(false);
    const result = resolveClientDist("/repo/server/dist");
    expect(result).toBe(path.join("/repo/server/dist", "..", "..", "client", "dist"));
  });
});
