"use strict";

// Minimal agent-kind plugin fixture (issue #507). The host spawns and supervises
// it over the same vscode-jsonrpc/stdio transport as an integration plugin, and
// registers NO component broker handlers for it, so this fixture can only answer
// the declarative `translateLaunch` contract method (AP-NFR-001).
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => ({
  schemaVersion: 1,
  kind: "agent-launch",
  command: "echo-agent",
  args: ["--session-id", "{{sessionId}}"],
  cwd: params && params.context ? params.context.workspacePath : undefined,
  capabilities: {
    workspaceWrites: [
      {
        relPath: ".agent/settings.local.json",
        format: "json",
        ops: [{ op: "set", path: "permissions.defaultMode", value: "plan" }],
      },
    ],
  },
}));

// Proof the plugin holds no component broker surface: it can ASK the host for
// one, but the host registers no such handler for an agent plugin, so the call
// comes back as JSON-RPC MethodNotFound (-32601).
connection.onRequest("probeBroker", async (params) => {
  const method = (params && params.method) || "host.process.start";
  try {
    await connection.sendRequest(method, {});
    return { reached: true };
  } catch (err) {
    return { reached: false, code: err && err.code, message: err && err.message };
  }
});

connection.listen();
