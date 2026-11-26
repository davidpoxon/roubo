import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bench } from "@roubo/shared";

vi.mock("./project-registry.js", () => ({ getProject: () => undefined }));

import {
  clearBenchRepathed,
  clearProjectRepathed,
  isBenchStaleFromRepath,
  markBenchesRepathed,
  resetForTests,
} from "./project-repath-state.js";
import { serializeBench } from "./bench-serializer.js";

function bench(projectId: string, id: number): Bench {
  return { id, projectId, branch: "b", workspacePath: "/w", ports: {} } as unknown as Bench;
}

beforeEach(() => {
  resetForTests();
});

describe("re-path stale marks (HR-FR-014)", () => {
  it("marks only the named benches of the re-pathed project", () => {
    markBenchesRepathed("lantern", [2]);
    expect(isBenchStaleFromRepath("lantern", 2)).toBe(true);
    expect(isBenchStaleFromRepath("lantern", 3)).toBe(false);
    expect(isBenchStaleFromRepath("harbour", 2)).toBe(false);
  });

  it("serialises a marked bench as stale from the re-path", () => {
    markBenchesRepathed("lantern", [2]);
    expect(serializeBench(bench("lantern", 2))).toMatchObject({
      stale: true,
      staleFromRepath: true,
    });
    const other = serializeBench(bench("lantern", 3));
    expect(other.stale).toBe(false);
    expect(other.staleFromRepath).toBeUndefined();
  });

  it("drops the mark of a cleared bench and of every bench of an unregistered project", () => {
    markBenchesRepathed("lantern", [2, 3]);
    markBenchesRepathed("harbour", [2]);
    clearBenchRepathed("lantern", 2);
    expect(isBenchStaleFromRepath("lantern", 2)).toBe(false);
    expect(isBenchStaleFromRepath("lantern", 3)).toBe(true);
    clearProjectRepathed("lantern");
    expect(isBenchStaleFromRepath("lantern", 3)).toBe(false);
    expect(isBenchStaleFromRepath("harbour", 2)).toBe(true);
  });
});
