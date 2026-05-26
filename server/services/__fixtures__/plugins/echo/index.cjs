"use strict";

const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("echo", (params) => params);

connection.onRequest("listIssueTypes", () => [
  { id: "bug", name: "Bug" },
  { id: "task", name: "Task" },
]);

connection.onRequest("ping", () => "pong");

// Exposes the child's process.argv so the host can verify spawn args (WU-063).
connection.onRequest("argv", () => process.argv);

connection.listen();
