"use strict";

// Instrumented ports-only component fixture for the CP-TC-099 enforced
// sandboxing e2e drift guard (issue #628). The host spawns and supervises it
// over the same vscode-jsonrpc/stdio transport as every other plugin.
//
// Its consent is ports only (see roubo-plugin.yaml): the declared host.ports.get
// is the only privileged broker call it is entitled to make. On `start` its
// instrumented hook does three things, exactly as CP-TC-099's preconditions
// require:
//   (a) calls the declared host.ports.get via the broker,
//   (b) attempts the undeclared host.docker.composeUp via the broker,
//   (c) attempts a direct outbound TCP connection from its OWN process code,
//       bypassing the broker entirely.
//
// Crucially, the direct TCP attempt is wrapped so a refused/blocked connection
// (an OS-level PluginIsolationSandbox deny-all egress) does NOT crash this
// process: an uncaught 'error' on the socket would take the plugin down and, in
// a naive host, its siblings with it. The fixture stays alive and listening so
// the e2e test can assert graceful degradation (S004-O02 / S005-O01).
const net = require("node:net");
const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

// Liveness probe so the test can confirm the process is up over the live
// connection after the blocked outbound attempt.
connection.onRequest("ping", () => "pong");

// Attempt a direct outbound TCP connection from the plugin's own code, bypassing
// the broker. Resolves with the outcome rather than throwing, and never lets a
// socket 'error' escape to crash the process (the deny-all sandbox refuses the
// connection at the OS layer).
function attemptDirectOutboundTcp(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let socket;
    try {
      socket = net.connect({ host, port });
    } catch (err) {
      done({ connected: false, error: String((err && err.message) || err) });
      return;
    }
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      done({ connected: true });
    });
    socket.once("timeout", () => {
      socket.destroy();
      done({ connected: false, error: "timeout" });
    });
    // The load-bearing line: a blocked/refused connection surfaces as an
    // 'error' event. Handling it here is what keeps the plugin alive instead of
    // crashing the host (graceful degradation).
    socket.once("error", (err) => {
      socket.destroy();
      done({ connected: false, error: String((err && err.message) || err) });
    });
  });
}

// The instrumented start hook. Drives the three attempts and reports a structured
// outcome the host/test can inspect. Broker calls go back to the host over the
// live connection (host-served methods); whether the host has the broker wired
// onto this connection is the host's concern, so each call is wrapped to report
// its JSON-RPC error code rather than throw.
connection.onRequest("start", async (params) => {
  const componentName =
    params && typeof params.componentName === "string" ? params.componentName : "http";
  const result = { portsGet: null, dockerComposeUp: null, directTcp: null };

  // (a) Declared call.
  try {
    const port = await connection.sendRequest("host.ports.get", { componentName });
    result.portsGet = { ok: true, port };
  } catch (err) {
    result.portsGet = {
      ok: false,
      code: err && typeof err.code === "number" ? err.code : null,
      message: err && err.message ? String(err.message) : String(err),
    };
  }

  // (b) Undeclared call.
  try {
    await connection.sendRequest("host.docker.composeUp", {
      projectName: "ports-only",
      composeFile: "docker-compose.yml",
      cwd: ".",
      service: "http",
    });
    result.dockerComposeUp = { ok: true };
  } catch (err) {
    result.dockerComposeUp = {
      ok: false,
      code: err && typeof err.code === "number" ? err.code : null,
      message: err && err.message ? String(err.message) : String(err),
    };
  }

  // (c) Direct outbound TCP, bypassing the broker. 192.0.2.1 is TEST-NET-1
  // (RFC 5737), guaranteed non-routable, so the attempt never reaches a real
  // host even if the sandbox were absent.
  result.directTcp = await attemptDirectOutboundTcp("192.0.2.1", 9);

  return result;
});

connection.listen();
