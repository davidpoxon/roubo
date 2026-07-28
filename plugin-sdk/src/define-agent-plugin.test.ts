import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { defineAgentPlugin } from "./define-agent-plugin.js";
import { SUPPORTED_AGENT_CONTRACT_VERSION } from "./types.js";
import type { AgentLaunchContext, AgentLaunchDescriptor, AgentPluginHandle } from "./types.js";

/**
 * Build a paired in-memory JSON-RPC connection: one half is the SDK under test
 * (driving `defineAgentPlugin`), the other half plays the host. Mirrors the
 * pattern in define-component-plugin.test.ts.
 */
function pairedConnection(): {
  pluginStreams: { input: PassThrough; output: PassThrough };
  hostConnection: MessageConnection;
  dispose: () => void;
} {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();

  const hostReader = new StreamMessageReader(pluginToHost);
  const hostWriter = new StreamMessageWriter(hostToPlugin);
  const hostConnection = createMessageConnection(hostReader, hostWriter);
  hostConnection.listen();

  return {
    pluginStreams: { input: hostToPlugin, output: pluginToHost },
    hostConnection,
    dispose: () => {
      try {
        hostConnection.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

const launchContext: AgentLaunchContext = {
  projectId: "proj-1",
  benchId: 2,
  workspacePath: "/tmp/ws",
  sessionId: "c3c4755c-9b91-4a77-8dd0-db88315ca4a7",
  effectiveConfig: { model: "haiku" },
  initialPrompt: "Ship it",
};

let handles: AgentPluginHandle[] = [];
let disposes: Array<() => void> = [];

afterEach(() => {
  for (const h of handles) {
    try {
      h.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const d of disposes) d();
  handles = [];
  disposes = [];
});

describe("defineAgentPlugin validation", () => {
  it("rejects an incompatible contractVersion at definition time", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    expect(() =>
      defineAgentPlugin(
        {
          translateLaunch: () => ({
            schemaVersion: 1,
            kind: "agent-launch",
            command: "x",
            args: [],
          }),
        },
        { contractVersion: SUPPORTED_AGENT_CONTRACT_VERSION + 1, streams: pluginStreams },
      ),
    ).toThrow(/contractVersion 2 is incompatible/);
  });

  it("rejects a contract that does not implement translateLaunch", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    expect(() => defineAgentPlugin({} as never, { streams: pluginStreams })).toThrow(
      /must implement translateLaunch/,
    );
  });

  it("accepts an explicitly supplied compatible contractVersion", () => {
    const { pluginStreams, dispose } = pairedConnection();
    disposes.push(dispose);

    const handle = defineAgentPlugin(
      {
        translateLaunch: () => ({ schemaVersion: 1, kind: "agent-launch", command: "x", args: [] }),
      },
      { contractVersion: SUPPORTED_AGENT_CONTRACT_VERSION, streams: pluginStreams },
    );
    handles.push(handle);
    expect(typeof handle.dispose).toBe("function");
  });
});

describe("defineAgentPlugin dispatch", () => {
  it("answers a translateLaunch request with the descriptor the contract returns", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      defineAgentPlugin(
        {
          translateLaunch({ config, context }) {
            return {
              schemaVersion: 1,
              kind: "agent-launch",
              command: "my-agent",
              args: ["--model", config.model as string, "--session-id", "{{sessionId}}"],
              cwd: context.workspacePath,
              initialPrompt: { mode: "argv-positional", maxLength: 100000 },
            };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const descriptor = await hostConnection.sendRequest<AgentLaunchDescriptor>("translateLaunch", {
      config: { model: "haiku" },
      context: launchContext,
    });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      kind: "agent-launch",
      command: "my-agent",
      args: ["--model", "haiku", "--session-id", "{{sessionId}}"],
      cwd: "/tmp/ws",
      initialPrompt: { mode: "argv-positional", maxLength: 100000 },
    });
  });

  it("awaits an async translateLaunch and carries declared capabilities through", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      defineAgentPlugin(
        {
          async translateLaunch() {
            return {
              schemaVersion: 1,
              kind: "agent-launch",
              command: "my-agent",
              args: [],
              capabilities: {
                workspaceWrites: [
                  {
                    relPath: ".agent/settings.json",
                    format: "json",
                    ops: [{ op: "unionArray", path: "permissions.allow", values: ["Bash(ls:*)"] }],
                  },
                ],
                waitingDetection: { kind: "quiescence-only", debounceMs: 2000 },
              },
            };
          },
        },
        { streams: pluginStreams },
      ),
    );

    const descriptor = await hostConnection.sendRequest<AgentLaunchDescriptor>("translateLaunch", {
      config: {},
      context: launchContext,
    });

    expect(descriptor.capabilities?.workspaceWrites?.[0].relPath).toBe(".agent/settings.json");
    expect(descriptor.capabilities?.waitingDetection).toEqual({
      kind: "quiescence-only",
      debounceMs: 2000,
    });
  });

  it("propagates a translateLaunch failure back to the host as an RPC error", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      defineAgentPlugin(
        {
          translateLaunch() {
            throw new Error("unsupported model");
          },
        },
        { streams: pluginStreams },
      ),
    );

    await expect(
      hostConnection.sendRequest("translateLaunch", { config: {}, context: launchContext }),
    ).rejects.toThrow(/unsupported model/);
  });

  it("registers no broker methods, so a privileged host.* call is MethodNotFound (AP-NFR-001)", async () => {
    const { pluginStreams, hostConnection, dispose } = pairedConnection();
    disposes.push(dispose);

    handles.push(
      defineAgentPlugin(
        {
          translateLaunch: () => ({
            schemaVersion: 1,
            kind: "agent-launch",
            command: "x",
            args: [],
          }),
        },
        { streams: pluginStreams },
      ),
    );

    // The agent handle deliberately exposes no `host` client, and no broker
    // method is registered on the connection.
    const handle = handles[handles.length - 1] as AgentPluginHandle & { host?: unknown };
    expect(handle.host).toBeUndefined();

    for (const method of ["process/start", "docker/composeUp", "fs/writeFile"]) {
      await expect(hostConnection.sendRequest(method, {})).rejects.toMatchObject({ code: -32601 });
    }
  });
});
