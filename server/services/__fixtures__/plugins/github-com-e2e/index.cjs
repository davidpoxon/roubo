"use strict";

// Spawnable integration-kind fixture mounted under the bundled plugin id
// "github-com" for the CP-TC-029 drift guard (issue #630). It rides the same
// vscode-jsonrpc/stdio transport the host spawns every plugin over, so the e2e
// test can prove the integration spawn path still works after the component
// kind / HOST_API_VERSION 1.3.0 bump.
//
// It registers only an integration RPC surface (ping + the assign-flow methods).
// The component broker (component.* are plugin-served; host.docker.* /
// host.process.* are host-served) is wired by bench-manager onto component-kind
// connections only, never onto an integration plugin. The fixture exposes a
// __probeHost helper so S004 can assert that real isolation against the live
// wiring: the host calls __probeHost(method), the plugin calls that method back
// to the host over the same connection, and reports the JSON-RPC error code the
// host returned (-32601 MethodNotFound when the host did not register that
// broker handler on this integration connection).
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("ping", () => "pong");
connection.onRequest("assignIssue", () => undefined);
connection.onRequest("unassignIssue", () => undefined);
connection.onRequest("getIssue", (params) => params);
connection.onRequest("listLabels", () => ["bug", "feature"]);

// Probe a host-side method by calling it back to the host over the live
// connection, so S004 can assert which host capabilities are actually reachable
// from this integration plugin (not a self-reported list). Returns the JSON-RPC
// error `code` the host responded with (e.g. -32601 MethodNotFound when the host
// did not register that handler on this connection), or 0 when the call resolved.
connection.onRequest("__probeHost", async (method) => {
  try {
    await connection.sendRequest(method, {});
    return { code: 0 };
  } catch (err) {
    const code = err && typeof err.code === "number" ? err.code : null;
    return { code, message: err && err.message ? String(err.message) : String(err) };
  }
});

connection.listen();
