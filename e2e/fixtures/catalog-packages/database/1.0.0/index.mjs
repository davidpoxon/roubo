// E2E fixture runtime of the `database` component plugin, one version of the
// package the e2e fixture catalog serves (server/services/e2e-catalog-packages.ts).
//
// The real plugin lives in roubo-plugins (plugins/database) and builds against
// the published SDK, so roubo's e2e suite cannot load it. This runtime mirrors
// its declarative contract: `translate` maps the component's opaque config to a
// `docker` ProvisionDescriptor (shared/provision-descriptor-schema.ts), and the
// host LifecycleEngine brings the compose service up. The runtime starts no
// container itself.
//
// ESM because the manifest entry is `./index.mjs`. The marketplace installs the
// package under the e2e user plugins root (e2e/fixtures/), so
// `vscode-jsonrpc/node` resolves from roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

function optionalString(config, key) {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`database e2e fixture: "${key}" must be a non-empty string.`);
  }
  return value;
}

function requiredString(config, key) {
  const value = optionalString(config, key);
  if (value === undefined) {
    throw new Error(`database e2e fixture: "${key}" is required.`);
  }
  return value;
}

function optionalEnv(config) {
  const value = config.env;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('database e2e fixture: "env" must be an object of strings.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`database e2e fixture: env "${key}" must be a string.`);
    }
  }
  return value;
}

function optionalConnection(config) {
  const value = config.connection;
  if (value === undefined || value === null) return undefined;
  const template = typeof value === "object" ? value.template : undefined;
  if (typeof template !== "string" || template.length === 0) {
    throw new Error('database e2e fixture: "connection.template" must be a non-empty string.');
  }
  return { template };
}

/** The component config as a `docker` ProvisionDescriptor. */
function translate(config) {
  const composeFile = requiredString(config, "composeFile");
  const service = requiredString(config, "service");
  const initService = optionalString(config, "initService");
  const portEnvVar = optionalString(config, "portEnvVar");
  const env = optionalEnv(config);
  const connection = optionalConnection(config);
  return {
    schemaVersion: 1,
    kind: "docker",
    composeFile,
    service,
    ...(initService !== undefined && { initService }),
    ...(portEnvVar !== undefined && { portEnvVar }),
    ...(env !== undefined && { env }),
    ...(connection !== undefined && { connection }),
  };
}

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translate", (params) => translate((params && params.config) || {}));

connection.listen();
