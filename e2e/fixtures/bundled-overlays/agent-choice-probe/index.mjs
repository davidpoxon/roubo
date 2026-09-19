// E2E overlay runtime for the `agent-choice-probe` agent plugin slot (issue
// #1306, APCC-TC-022).
//
// The manifest is the thing under test: its `probedModel` choice probe is what
// puts the AI Agents screen's field in the resolved, loading or failed state.
// The runtime only has to exist, because `resolveAgent` refuses a plugin with no
// live JSON-RPC connection, and the host warms choice probes only for an agent
// that resolves. So it answers `translateLaunch` and nothing else, like the unit
// fixture it mirrors (server/services/__fixtures__/plugins/agent-choice-probe/).
//
// ESM because the manifest entry is `./index.mjs`, and `vscode-jsonrpc/node`
// resolves from roubo/node_modules, as for the sibling overlays.

import * as rpc from "vscode-jsonrpc/node";

/** The stub CLI, never a real agent's name (see the manifest). */
const COMMAND = "roubo-e2e-probe-stub";

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => ({
  schemaVersion: 1,
  kind: "agent-launch",
  command: COMMAND,
  args: [],
  cwd: params && params.context ? params.context.workspacePath : undefined,
}));

connection.listen();
