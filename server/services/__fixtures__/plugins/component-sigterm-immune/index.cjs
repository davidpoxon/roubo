"use strict";

// Component-kind plugin fixture that ignores SIGTERM (#1387). It models a plugin
// on the Docker isolation tier, where node runs as PID 1 in the container and
// has no default SIGTERM action, so the host's stop only ends it with SIGKILL
// after the shutdown grace. Otherwise it is the component-echo fixture. The
// handler is installed before anything else, so once the plugin answers `ping`
// it is certain to ignore SIGTERM.
process.on("SIGTERM", () => {});

const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("ping", () => "pong");
connection.onRequest("echo", (params) => params);

connection.listen();
