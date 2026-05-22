"use strict";

const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("oversized", () => {
  // ~12MB payload
  const chunk = "x".repeat(12 * 1024 * 1024);
  return { payload: chunk };
});

connection.onRequest("ping", () => "pong");

connection.listen();
