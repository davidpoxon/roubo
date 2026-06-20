"use strict";

// Minimal component-kind plugin fixture. The host spawns and supervises it over
// the same vscode-jsonrpc/stdio transport as an integration plugin (issue
// #608). It answers `ping` so a test can assert the live connection round-trips
// after discovery + spawn.
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("ping", () => "pong");
connection.onRequest("echo", (params) => params);

connection.listen();
