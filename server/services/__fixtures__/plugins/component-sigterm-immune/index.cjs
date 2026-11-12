"use strict";

// Component-kind plugin fixture that ignores SIGTERM (#1387). It models a plugin
// that installs its own SIGTERM handler and outlives the signal, so the host's
// stop only ends it with SIGKILL after the shutdown grace. Before #1501 added
// --init, every plugin on the Docker isolation tier behaved this way, because
// node ran as PID 1 in the container and had no default SIGTERM action. Otherwise it is the component-echo fixture. The
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
