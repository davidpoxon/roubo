import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bench } from "@roubo/shared";

vi.mock("./state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state.js")>();
  return { ...actual, updateBench: vi.fn() };
});

import * as state from "./state.js";
import {
  hashDeliveryToken,
  mintDeliveryToken,
  revokeDeliveryToken,
  verifyDeliveryToken,
} from "./delivery-token-registry.js";

function specBench(): Bench {
  return {
    id: 2,
    projectId: "demo",
    branch: "b",
    workspacePath: "/tmp/ws",
    status: "idle",
    ports: {},
    components: {},
    createdAt: "2026-10-16T09:00:00Z",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    assignedContainers: {},
    assignedIssue: null,
    variant: "specbench",
    focusedSpecPath: "/tmp/repo/.specifications/fixture-spec",
    deliveryBindMode: "launch",
  } as unknown as Bench;
}

beforeEach(() => {
  vi.mocked(state.updateBench).mockClear();
});

describe("delivery token registry", () => {
  it("stores only the hash of a minted token, and persists it", () => {
    const bench = specBench();
    const token = mintDeliveryToken(bench);

    expect(bench.deliveryTokenHash).toBe(hashDeliveryToken(token));
    expect(bench.deliveryTokenHash).not.toContain(token);
    const persisted = vi.mocked(state.updateBench).mock.calls.at(-1)?.[0];
    expect(persisted?.deliveryTokenHash).toBe(bench.deliveryTokenHash);
    expect(JSON.stringify(persisted)).not.toContain(token);
  });

  it("verifies the current token only, and a new mint replaces the old one", () => {
    const bench = specBench();
    const first = mintDeliveryToken(bench);
    expect(verifyDeliveryToken(bench, first)).toBe(true);
    expect(verifyDeliveryToken(bench, "other")).toBe(false);
    expect(verifyDeliveryToken(bench, undefined)).toBe(false);
    expect(verifyDeliveryToken(bench, "")).toBe(false);

    const second = mintDeliveryToken(bench);
    expect(second).not.toBe(first);
    expect(verifyDeliveryToken(bench, first)).toBe(false);
    expect(verifyDeliveryToken(bench, second)).toBe(true);
  });

  it("verifies nothing once revoked, or against a malformed stored hash", () => {
    const bench = specBench();
    const token = mintDeliveryToken(bench);
    revokeDeliveryToken(bench);
    expect(bench.deliveryTokenHash).toBeUndefined();
    expect(verifyDeliveryToken(bench, token)).toBe(false);

    bench.deliveryTokenHash = "not-a-hash";
    expect(verifyDeliveryToken(bench, token)).toBe(false);
  });
});
