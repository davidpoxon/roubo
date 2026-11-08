// The launch descriptor reaches the delivery session under the env keys its
// delivery kernel reads (#1601). With other names the kernel finds no bench
// endpoint, so it posts no event and reads no control.
import { describe, expect, it, vi } from "vitest";

vi.mock("./bench-manager.js", () => ({}));
vi.mock("./project-registry.js", () => ({}));
vi.mock("./state.js", () => ({}));
vi.mock("./terminal.js", () => ({}));
vi.mock("./notification.js", () => ({ createNotification: vi.fn() }));

import { deliveryLaunchEnv, deliveryLaunchPrompt } from "./delivery-session-launcher.js";

const descriptor = {
  eventUrl: "http://localhost:3335/api/hooks/delivery-event?projectId=demo&benchId=4",
  controlsUrl: "http://localhost:3335/api/hooks/delivery-controls?projectId=demo&benchId=4",
  token: "secret-token-value",
};

describe("deliveryLaunchEnv", () => {
  it("hands the endpoints and the token over under the kernel's bench keys", () => {
    expect(deliveryLaunchEnv(descriptor)).toEqual({
      DELIVERY_BENCH_EVENT_URL: descriptor.eventUrl,
      DELIVERY_BENCH_CONTROLS_URL: descriptor.controlsUrl,
      DELIVERY_BENCH_TOKEN: descriptor.token,
    });
  });

  it("keeps the resume and decision mode keys that only the session reads", () => {
    const env = deliveryLaunchEnv({
      ...descriptor,
      resume: "demo-delivery-1",
      decisionMode: "auto",
    });
    expect(env.ROUBO_DELIVERY_RESUME).toBe("demo-delivery-1");
    expect(env.ROUBO_DELIVERY_DECISION_MODE).toBe("auto");
  });
});

describe("deliveryLaunchPrompt", () => {
  it("names the kernel's bench keys and never the token", () => {
    const prompt = deliveryLaunchPrompt({
      projectId: "demo",
      benchId: 4,
      workspacePath: "/repo",
      specSlug: "fixture-spec",
      descriptor: { ...descriptor, decisionMode: "auto" },
    });
    expect(prompt).toContain("$DELIVERY_BENCH_EVENT_URL");
    expect(prompt).toContain("$DELIVERY_BENCH_CONTROLS_URL");
    expect(prompt).toContain("$DELIVERY_BENCH_TOKEN");
    expect(prompt).toContain("$ROUBO_DELIVERY_DECISION_MODE");
    expect(prompt).not.toContain(descriptor.token);
  });
});
