import { describe, expect, it } from "vitest";
import type { Bench, BenchNotification, TerminalSession } from "@roubo/shared";
import { deliveryStartup } from "./delivery-startup-model";

type StartupBench = Pick<
  Bench,
  "status" | "deliveryBindMode" | "deliverySessionId" | "notifications"
>;

const launch = (over: Partial<StartupBench> = {}): StartupBench => ({
  status: "active",
  deliveryBindMode: "launch",
  notifications: [],
  ...over,
});

const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  id: "s-1",
  benchKey: "demo:3",
  label: "agent",
  createdAt: "2026-10-16T09:01:00Z",
  status: "live",
  ...over,
});

const note = (over: Partial<BenchNotification>): BenchNotification => ({
  id: "n",
  type: "agent-waiting",
  priority: "action-needed",
  createdAt: "2026-10-16T09:02:00Z",
  ...over,
});

function statuses(bench: StartupBench, s?: TerminalSession) {
  const { phase, steps } = deliveryStartup(bench, s);
  return { phase, steps: Object.fromEntries(steps.map((step) => [step.id, step.status])) };
}

describe("deliveryStartup", () => {
  it("runs the workspace step while the bench prepares", () => {
    expect(statuses(launch({ status: "preparing" }))).toEqual({
      phase: "starting",
      steps: {
        workspace: "running",
        session: "pending",
        planning: "pending",
        operator: "pending",
        record: "pending",
      },
    });
  });

  it("starts the session once the workspace is ready and no session is recorded", () => {
    expect(statuses(launch()).steps.session).toBe("running");
    expect(statuses(launch()).phase).toBe("starting");
  });

  it("plans while the recorded session runs with no action needed", () => {
    expect(statuses(launch({ deliverySessionId: "s-1" }), session())).toEqual({
      phase: "planning",
      steps: {
        workspace: "done",
        session: "done",
        planning: "running",
        operator: "pending",
        record: "pending",
      },
    });
  });

  it("waits for the operator while the session raised an action-needed notification", () => {
    const bench = launch({
      deliverySessionId: "s-1",
      notifications: [note({ sourceSessionId: "s-1" })],
    });
    expect(statuses(bench, session())).toMatchObject({
      phase: "awaiting-operator",
      steps: { planning: "done", operator: "running" },
    });
  });

  it("ignores an action-needed notification of another session", () => {
    const bench = launch({
      deliverySessionId: "s-1",
      notifications: [note({ sourceSessionId: "s-other" })],
    });
    expect(statuses(bench, session()).phase).toBe("planning");
  });

  it("names a failed create-time launch", () => {
    const bench = launch({
      notifications: [
        note({
          type: "agent-launch-failed",
          metadata: { message: "The delivery session did not start: no agent" },
        }),
      ],
    });
    const result = deliveryStartup(bench, undefined);
    expect(result.phase).toBe("launch-failed");
    expect(result.steps[1]).toMatchObject({
      status: "error",
      detail: "The delivery session did not start: no agent",
    });
  });

  it("drops a launch failure older than the session the bench now records", () => {
    const bench = launch({
      deliverySessionId: "s-1",
      notifications: [note({ type: "agent-launch-failed", createdAt: "2026-10-16T09:00:00Z" })],
    });
    expect(statuses(bench, session()).phase).toBe("planning");
  });

  it("names a session that ended before it wrote the record", () => {
    const result = deliveryStartup(
      launch({ deliverySessionId: "s-1" }),
      session({ status: "ended", exitCode: 2 }),
    );
    expect(result.phase).toBe("session-ended");
    expect(result.steps[1].detail).toMatch(/exit code 2/);
  });

  it.each(["error", "clearing"] as const)(
    "reads the bench as unavailable while it is %s",
    (status) => {
      expect(statuses(launch({ status })).phase).toBe("bench-unavailable");
    },
  );

  it("waits for the running delivery on an attached bench", () => {
    expect(statuses(launch({ deliveryBindMode: "attach" }))).toEqual({
      phase: "attach-waiting",
      steps: { workspace: "done", attach: "running" },
    });
  });
});
