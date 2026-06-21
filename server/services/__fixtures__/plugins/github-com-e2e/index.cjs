"use strict";

// Spawnable integration-kind fixture mounted under the bundled plugin id
// "github-com" for the CP-TC-029 drift guard (issue #630). It rides the same
// vscode-jsonrpc/stdio transport the host spawns every plugin over, so the e2e
// test can prove the integration spawn path still works after the component
// kind / HOST_API_VERSION 1.3.0 bump. It also reports its own registered
// JSON-RPC method names so the test can assert no component-kind broker methods
// leaked into the integration plugin's namespace (S004).
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

// The integration RPC surface this plugin registers. An integration plugin
// only ever registers integration methods; the host's component broker
// (component.*, host.docker.*, host.process.*, host.component.*) is wired by
// bench-manager onto component-kind connections only, never here.
const REGISTERED_METHODS = ["ping", "assignIssue", "unassignIssue", "getIssue", "listLabels"];

connection.onRequest("ping", () => "pong");
connection.onRequest("assignIssue", () => undefined);
connection.onRequest("unassignIssue", () => undefined);
connection.onRequest("getIssue", (params) => params);
connection.onRequest("listLabels", () => ["bug", "feature"]);

// Introspection helper: the host uses this to read the plugin's own registered
// method list and assert the component-kind surface was not injected (S004).
connection.onRequest("__methods", () => REGISTERED_METHODS);

connection.listen();
