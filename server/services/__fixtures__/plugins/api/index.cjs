"use strict";

// Long-lived sibling 'api' component fixture for the CP-TC-099 enforced
// sandboxing e2e drift guard (issue #628). The host spawns and supervises it
// over the same vscode-jsonrpc/stdio transport as every other plugin. It answers
// a liveness ping and otherwise just stays running, so the e2e test can assert
// the sibling remains 'running' throughout while the offending ports-only
// plugin's undeclared actions are blocked and audited (graceful degradation).
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("ping", () => "pong");

connection.listen();
