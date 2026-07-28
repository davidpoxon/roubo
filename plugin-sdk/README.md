# @roubo/plugin-sdk

Plugin author SDK for Roubo plugins. Provides one `define*` entry point per plugin kind, plus a `host` client, so plugin code talks to Roubo's JSON-RPC protocol without writing any framing.

| Kind          | Entry point             | What the plugin does                                                         |
| ------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `integration` | `definePlugin`          | Answers issue-tracker queries (`listIssues`, `getIssue`, ...).               |
| `component`   | `defineComponentPlugin` | Provisions a bench component, declaratively or through the lifecycle hooks.  |
| `agent`       | `defineAgentPlugin`     | Translates a launch request for an AI coding agent into a launch descriptor. |

```ts
import { definePlugin, host } from "@roubo/plugin-sdk";

definePlugin({
  async getCurrentUser() {
    const token = await host.credentials.get("api-token");
    const res = await host.fetch("https://api.example.com/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    const user = JSON.parse(res.body as string);
    return { externalId: user.id, displayName: user.name };
  },
  async listIssues({ cursor, pageSize }) {
    return { items: [], nextCursor: null };
  },
});
```

An agent plugin implements one pure function, `translateLaunch`, and returns an `AgentLaunchDescriptor` the host validates and executes:

```ts
import { defineAgentPlugin } from "@roubo/plugin-sdk";

defineAgentPlugin({
  translateLaunch({ config, context }) {
    return {
      schemaVersion: 1,
      kind: "agent-launch",
      command: "my-agent",
      args: ["--model", config.model as string, "--session-id", "{{sessionId}}"],
      cwd: context.workspacePath,
      capabilities: {
        workspaceWrites: [
          {
            relPath: ".my-agent/settings.json",
            format: "json",
            ops: [{ op: "set", path: "permissions.defaultMode", value: "plan" }],
          },
        ],
      },
    };
  },
});
```

The agent contract is declarative only: there is no imperative escape hatch and no host client. The host owns the process spawn, every workspace write, the notification wiring, and the version probe, so an agent plugin holds no privilege beyond what an integration plugin already has. Every capability under `capabilities` is optional, and absence is first-class: an agent that declares none launches as a plain terminal session.

Full author docs, including the manifest format, every contract method, the agent contract, pagination, error shapes, host helpers, and the trust model, live at [`docs/plugin-sdk.md`](../docs/plugin-sdk.md) in the Roubo repo.
