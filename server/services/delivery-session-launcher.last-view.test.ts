// A Spec Bench bound to its delivery again (Cleanup & Retry re-provisions the
// workspace, so the delivery starts its seq again) forgets the operator's last
// view of the old delivery, and saves the bench (SB-FR-012).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";

vi.mock("./bench-manager.js", () => ({
  getBench: vi.fn(),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));
vi.mock("./state.js", async (importOriginal) => ({
  updateBench: vi.fn(),
  toPersistedBench: (await importOriginal<typeof import("./state.js")>()).toPersistedBench,
}));
vi.mock("./terminal.js", () => ({}));
vi.mock("./notification.js", () => ({ createNotification: vi.fn() }));

import * as benchManager from "./bench-manager.js";
import * as stateService from "./state.js";
import { makeBench } from "../test/fixtures.js";
import { bindDeliveryOnCreate } from "./delivery-session-launcher.js";

let bench: Bench;

beforeEach(() => {
  bench = makeBench({
    id: 4,
    projectId: "demo",
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    // Attach mode launches nothing, so the binding settles at once.
    deliveryBindMode: "attach",
    deliveryLastViewedSeq: 120,
    deliveryLastViewedDeliveryId: "demo-delivery-1",
  });
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(stateService.updateBench).mockClear();
});

describe("bindDeliveryOnCreate", () => {
  it("SB-TC-023 forgets the last view of the old delivery and saves the bench", async () => {
    await bindDeliveryOnCreate(bench);
    expect(bench.deliveryLastViewedSeq).toBeUndefined();
    expect(bench.deliveryLastViewedDeliveryId).toBeUndefined();
    expect(vi.mocked(stateService.updateBench)).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(stateService.updateBench).mock.calls[0]?.[0];
    expect(saved).toMatchObject({ id: 4 });
    expect(saved).not.toHaveProperty("deliveryLastViewedSeq");
    expect(saved).not.toHaveProperty("deliveryLastViewedDeliveryId");
  });

  it("SB-TC-023 saves nothing when the bench held no last view", async () => {
    bench.deliveryLastViewedSeq = undefined;
    bench.deliveryLastViewedDeliveryId = undefined;
    await bindDeliveryOnCreate(bench);
    expect(vi.mocked(stateService.updateBench)).not.toHaveBeenCalled();
  });
});
