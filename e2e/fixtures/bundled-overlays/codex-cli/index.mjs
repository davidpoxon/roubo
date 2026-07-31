// E2E overlay runtime for a second agent plugin slot, `codex-cli` (issue #683).
//
// NOT a mirror of a shipped plugin. There is no Codex agent plugin yet (#520
// owns it), so this file implements the smallest runtime that makes the slot a
// REAL installed agent rather than a manifest on disk: `resolveAgent` refuses to
// resolve a plugin with no live JSON-RPC connection, and both `warmAgentVersion`
// callers (server boot and GET /api/agents) are gated on that resolution. Without
// a running entrypoint the card would render its declared window with no detected
// version, which is exactly the half of AP-TC-113 S002-O01 that needs proving.
//
// Deliberately minimal where the real plugin will be rich: the argv mapping,
// the config schema, the notification wiring and the permissions bindings are
// #520's to author from spike 502
// (.specifications/agent-plugins/spikes/spike-502-agent-contract-shape.md).
// Inventing them here would fixture behaviour nobody owns, and a guard that
// asserts against an invented mapping proves nothing about the shipped one.
//
// Modelled on the sibling claude-code overlay for the JSON-RPC shape; ESM
// because the manifest entry is `./index.mjs` and `vscode-jsonrpc/node` resolves
// from roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

/**
 * The stub CLI the host spawns. Deliberately NOT `codex`: `resolveShellPath()`
 * prepends `~/.local/bin`, so a real Codex install would otherwise win the
 * lookup and the harness would drive the real CLI.
 */
const COMMAND = "roubo-e2e-codex-stub";

/**
 * Codex's interactive form is `codex [OPTIONS] [PROMPT]` (spike 502, section 2),
 * so a positional initial prompt is the faithful mode. No length bound is
 * declared: the real limit is #520's to establish against the real binary, and
 * an invented one would silently truncate a jig here.
 */
const INITIAL_PROMPT = { mode: "argv-positional" };

/**
 * Matches the manifest's `agentCompatibility` window exactly. The manifest block
 * is what the AI Agents card reads without a launch; this one is what a launch
 * re-probes through the same per-binary cache, so a divergence between them
 * would show as a card and a launch gate disagreeing about the same CLI.
 */
const VERSION_PROBE = {
  args: ["--version"],
  parse: "semver",
  minVersion: "0.144.0",
  testedCeiling: "0.160.0",
};

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", () => ({
  schemaVersion: 1,
  kind: "agent-launch",
  command: COMMAND,
  // No generated flags: the manifest declares no config fields, so there is
  // nothing to map. The host appends the initial prompt (if any) as the last
  // positional.
  args: [],
  initialPrompt: INITIAL_PROMPT,
  capabilities: { versionProbe: VERSION_PROBE },
}));

connection.listen();
