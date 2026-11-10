// The default delivery launch executor runs the agent plugin chosen at set-up
// (#1616). With no choice it resolves the default agent plugin, and a chosen
// agent plugin that is no longer available fails the launch rather than
// running a different one.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  available: new Set<string>(),
  defaultAgent: undefined as string | undefined,
}));

vi.mock("./bench-manager.js", () => ({}));
vi.mock("./notification.js", () => ({ createNotification: vi.fn() }));
vi.mock("./project-registry.js", () => ({ getProject: vi.fn(() => undefined) }));
vi.mock("./state.js", () => ({
  loadSettings: vi.fn(() => ({ jigs: { defaultAgentPluginId: "agent-default" } })),
  getProjectPermissions: vi.fn(() => ({ allow: [], deny: [], ask: [] })),
}));
vi.mock("./terminal.js", () => ({
  createAgentSession: vi.fn(async () => ({ session: { id: "session-1" } })),
}));
vi.mock("./agent-launch-pipeline.js", () => ({
  resolveLaunchAgentId: vi.fn(() => hoisted.defaultAgent),
}));
vi.mock("./agent-plugin-registry.js", () => ({
  resolveAgent: vi.fn((pluginId: string) =>
    hoisted.available.has(pluginId)
      ? { pluginId, manifest: {}, connection: {} }
      : { reason: "not-installed", pluginId },
  ),
  isAgentNotAvailable: (value: object) => "reason" in value,
  describeAgentNotAvailable: (value: { pluginId: string }) =>
    `Agent plugin "${value.pluginId}" is not installed.`,
}));

import * as terminal from "./terminal.js";
import { resolveLaunchAgentId } from "./agent-launch-pipeline.js";
import {
  DeliveryLaunchError,
  defaultDeliveryLaunchExecutor,
  type DeliveryLaunchRequest,
} from "./delivery-session-launcher.js";

const request: DeliveryLaunchRequest = {
  projectId: "demo",
  benchId: 4,
  workspacePath: "/workspaces/bench-4",
  specSlug: "fixture-spec",
  descriptor: {
    eventUrl: "http://localhost:3335/api/hooks/delivery-event?projectId=demo&benchId=4",
    controlsUrl: "http://localhost:3335/api/hooks/delivery-controls?projectId=demo&benchId=4",
    token: "secret-token-value",
  },
};

beforeEach(() => {
  hoisted.available.clear();
  hoisted.defaultAgent = undefined;
  vi.clearAllMocks();
});

describe("defaultDeliveryLaunchExecutor agent plugin", () => {
  it("launches the chosen agent plugin, not the default", async () => {
    hoisted.available.add("agent-two");
    hoisted.defaultAgent = "agent-default";
    const result = await defaultDeliveryLaunchExecutor.launch({
      ...request,
      agentPluginId: "agent-two",
    });
    expect(result).toEqual({ sessionId: "session-1" });
    expect(terminal.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "agent-two", workspacePath: request.workspacePath }),
    );
    expect(resolveLaunchAgentId).not.toHaveBeenCalled();
  });

  it("launches the default agent plugin when none was chosen", async () => {
    hoisted.defaultAgent = "agent-default";
    await defaultDeliveryLaunchExecutor.launch(request);
    expect(resolveLaunchAgentId).toHaveBeenCalledWith({ defaultAgentPluginId: "agent-default" });
    expect(terminal.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "agent-default" }),
    );
  });

  it("fails the launch, naming why, when the chosen agent plugin is no longer available", async () => {
    hoisted.defaultAgent = "agent-default";
    const launch = defaultDeliveryLaunchExecutor.launch({
      ...request,
      agentPluginId: "agent-gone",
    });
    await expect(launch).rejects.toBeInstanceOf(DeliveryLaunchError);
    await expect(launch).rejects.toThrow(/Agent plugin "agent-gone" is not installed/);
    expect(terminal.createAgentSession).not.toHaveBeenCalled();
  });

  it("fails the launch when no agent plugin was chosen and none resolves", async () => {
    await expect(defaultDeliveryLaunchExecutor.launch(request)).rejects.toThrow(
      /No AI coding agent is available/,
    );
    expect(terminal.createAgentSession).not.toHaveBeenCalled();
  });
});
