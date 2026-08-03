// E2E overlay runtime for a third agent plugin slot, `gemini-cli` (issue #534).
//
// NOT a mirror of a shipped plugin: no Gemini agent plugin exists in
// roubo-plugins/plugins/ yet. It implements the smallest runtime that makes the
// slot a REAL installed agent rather than a manifest on disk: `resolveAgent`
// refuses to resolve a plugin with no live JSON-RPC connection, and both
// `warmAgentVersion` callers (server boot and GET /api/agents) are gated on that
// resolution. Without a running entrypoint the AI Agents card would render its
// declared window with no detected version and the AP-TC-115 launch could never
// spawn anything.
//
// The argv mapping below is this overlay's OWN, not a reproduction of any
// shipped plugin's, so it proves nothing about a real Gemini plugin's flags.
// AP-TC-115 observes no argv, so the mapping exists only to keep the overlay
// coherent: defaults saved on the AI Agents form in S005 do reach the child that
// S007 launches, rather than being persisted into a launch that ignores them.
//
// Modelled on the sibling codex-cli overlay for the JSON-RPC shape; ESM because
// the manifest entry is `./index.mjs` and `vscode-jsonrpc/node` resolves from
// roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

/**
 * The stub CLI the host spawns. Deliberately NOT `gemini`: `resolveShellPath()`
 * prepends `~/.local/bin`, so a real Gemini CLI install would otherwise win the
 * lookup and the harness would drive the real CLI.
 */
const COMMAND = "roubo-e2e-gemini-stub";

/** The closed choice lists the manifest's configSchema declares. */
const MODELS = ["default", "gemini-2.5-pro", "gemini-2.5-flash"];
const APPROVALS = ["default", "auto-edit", "yolo"];

/**
 * Gemini CLI's interactive form takes a positional prompt, so a positional
 * initial prompt is the faithful mode. No length bound is declared: this overlay
 * drives the e2e stub rather than a real binary, so a cap here would be a number
 * no guard proves anything about.
 */
const INITIAL_PROMPT = { mode: "argv-positional" };

/**
 * Matches the manifest's `agentCompatibility` window exactly. The manifest block
 * is what the marketplace listing and the AI Agents card read without a launch;
 * this one is what a launch re-probes through the same per-binary cache, so a
 * divergence between them would show as a card and a launch gate disagreeing
 * about the same CLI.
 */
const VERSION_PROBE = {
  args: ["--version"],
  parse: "semver",
  minVersion: "0.9.0",
  testedCeiling: "1.2.3",
};

/**
 * One closed-choice field. An absent, null or empty value reads as the field's
 * sentinel default; an unrecognised one is rejected rather than passed through
 * as an opaque argv token.
 */
function readChoice(value, allowed, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new Error(
    `gemini-cli e2e overlay: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
}

/**
 * The generated argv: the two closed-choice flags, then the extra arguments
 * split on whitespace. A literal split, not a shell: nothing here interprets
 * `;`, `&`, `|`, `$` or backticks, which is the half of AP-NFR-001 a plugin
 * owns.
 */
function buildArgs(config) {
  const args = [];

  const model = readChoice(config.modelName, MODELS, "modelName");
  if (model !== undefined && model !== "default") args.push("--model", model);

  const approval = readChoice(config.approval, APPROVALS, "approval");
  if (approval !== undefined && approval !== "default") args.push("--approval-mode", approval);

  const cliArgs = config.cliArgs;
  if (cliArgs !== undefined && cliArgs !== null) {
    if (typeof cliArgs !== "string") {
      throw new Error(
        `gemini-cli e2e overlay: "cliArgs" must be a string, but it was ${typeof cliArgs}.`,
      );
    }
    args.push(...cliArgs.split(/\s+/).filter((token) => token.length > 0));
  }

  return args;
}

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => {
  const config = (params && params.config) || {};
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    // The host appends the initial prompt (if any) after these as the last
    // positional.
    args: buildArgs(config),
    initialPrompt: INITIAL_PROMPT,
    capabilities: { versionProbe: VERSION_PROBE },
  };
});

connection.listen();
