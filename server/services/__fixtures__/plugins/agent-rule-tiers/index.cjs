"use strict";

// Minimal agent-kind plugin fixture for the rule-tiers manifest (#862). The
// host only has to discover, validate, and spawn it; the manifest is the thing
// under test, so the plugin answers `translateLaunch` and nothing else.
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => ({
  schemaVersion: 1,
  kind: "agent-launch",
  command: "tiered-agent",
  args: [],
  cwd: params && params.context ? params.context.workspacePath : undefined,
}));

connection.listen();
