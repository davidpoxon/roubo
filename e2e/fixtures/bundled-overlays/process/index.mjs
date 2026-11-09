// E2E overlay runtime for the `process` component plugin slot.
//
// The real plugin lives in roubo-plugins (plugins/process) and builds against
// the published SDK, so roubo's e2e suite cannot load it. This overlay mirrors
// its declarative contract: `translate` maps the component's opaque config to a
// `process` ProvisionDescriptor (shared/provision-descriptor-schema.ts), and the
// host LifecycleEngine starts the command. The overlay spawns nothing itself.
//
// What a guard on this overlay proves is the HOST side: that a component bound
// to `process` in a roubo.yaml resolves to a running plugin, and that a new
// bench starts the command the saved roubo.yaml declares. The plugin's own
// mapping is unit-covered in roubo-plugins.
//
// ESM because the manifest entry is `./index.mjs`; `vscode-jsonrpc/node`
// resolves from roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

function optionalString(config, key) {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`process e2e overlay: "${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalEnv(config) {
  const value = config.env;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('process e2e overlay: "env" must be an object of strings.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`process e2e overlay: env "${key}" must be a string.`);
    }
  }
  return value;
}

function optionalShell(config) {
  const value = config.shell;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error('process e2e overlay: "shell" must be a boolean or a non-empty string.');
}

/** The component config as a `process` ProvisionDescriptor. */
function translate(config) {
  const command = optionalString(config, "command");
  if (command === undefined) {
    throw new Error('process e2e overlay: "command" is required.');
  }
  const setup = optionalString(config, "setup");
  const env = optionalEnv(config);
  const envFile = optionalString(config, "envFile");
  const cwd = optionalString(config, "directory");
  const shell = optionalShell(config);
  return {
    schemaVersion: 1,
    kind: "process",
    command,
    ...(setup !== undefined && { setup }),
    ...(env !== undefined && { env }),
    ...(envFile !== undefined && { envFile }),
    ...(cwd !== undefined && { cwd }),
    ...(shell !== undefined && { shell }),
  };
}

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translate", (params) => translate((params && params.config) || {}));

connection.listen();
