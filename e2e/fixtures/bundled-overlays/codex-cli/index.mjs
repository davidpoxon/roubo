// E2E overlay runtime for the `codex-cli` agent plugin slot (issues #683, #532).
//
// SOURCE OF TRUTH: roubo-plugins/plugins/codex/src/translate-launch.ts and
// roubo-plugins/plugins/codex/src/tokenize.ts. The flag ordering, the concrete
// per-axis defaults, the waiting-detection debounce and the tokenizer below are
// a MIRROR of those two modules, kept here only because roubo's e2e suite cannot
// depend on the roubo-plugins workspace (the plugins there build against the
// published SDK).
//
// A running entrypoint is also what makes the slot a REAL installed agent rather
// than a manifest on disk: `resolveAgent` refuses to resolve a plugin with no
// live JSON-RPC connection, and both `warmAgentVersion` callers (server boot and
// GET /api/agents) are gated on that resolution. Without it the card would
// render its declared window with no detected version, which is exactly the half
// of AP-TC-113 S002-O01 that needs proving.
//
// PARTIAL CIRCULARITY, stated plainly: because this overlay implements the argv
// mapping itself, the AP-TC-056 / AP-TC-105 guards cannot prove the real
// plugin's `buildArgs`. That mapping is unit-covered in roubo-plugins
// (translate-launch.test.ts, tokenize.test.ts). What those guards do prove is
// the HOST-side integrated path: that the AI Agents form persists app-level
// Codex defaults, that a launch resolves them through the four-layer config,
// that they reach the spawned CLI as separate argv tokens with no shell
// interpretation, and that the plugin's declared quiescence window is what
// raises the waiting notification.
//
// Still deliberately minimal where the real plugin is rich: the notification
// wiring (Codex's own `notify` program) and the permissions bindings stay out of
// this file. Neither is on the AP-US-009 journey, and reproducing them would add
// fixture surface no case reads.
//
// Modelled on the sibling claude-code overlay for the JSON-RPC shape; ESM
// because the manifest entry is `./index.mjs` and `vscode-jsonrpc/node` resolves
// from roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

/**
 * The stub CLI the host spawns. Deliberately NOT `codex`: `importLoginShellEnv()`
 * prepends `~/.local/bin`, so a real Codex install would otherwise win the
 * lookup and the harness would drive the real CLI.
 */
const COMMAND = "roubo-e2e-codex-stub";

/** Mirrors the real plugin's MAX_PROMPT_LENGTH. */
const MAX_PROMPT_LENGTH = 100_000;

/**
 * Codex's interactive form is `codex [OPTIONS] [PROMPT]` (spike 502, section 2),
 * so a positional initial prompt is the faithful mode, and it is the ONLY
 * injection mechanism this plugin declares: no hook, no scheduled PTY write.
 * AP-TC-056 S002 is exactly that fact, observed from the host's own report of
 * the launch and from the jig arriving as the trailing argv positional.
 */
const INITIAL_PROMPT = { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH };

const MODELS = ["default", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const APPROVAL_POLICIES = ["untrusted", "on-request", "never"];
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

/**
 * Mirrors the real plugin's per-axis fallbacks, which equal the manifest
 * `configSchema` defaults. Unlike the Claude Code plugin's "send no flag"
 * sentinels, three of the Codex axes fall back on CONCRETE values, so the argv
 * the AI Agents form describes and the argv that launches stay the same thing.
 */
const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_EFFORT = "medium";
const DEFAULT_APPROVAL_POLICY = "on-request";
const DEFAULT_SANDBOX = "workspace-write";

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
  testedCeiling: "0.144.1",
};

/**
 * Mirrors the real plugin's WAITING_DETECTION.
 *
 * Quiescence-only, because Codex has no signal for the case that matters: an
 * approval prompt paints once and then goes silent. Declaring it is what makes
 * the host use the AGENT's 3000ms window rather than the generic terminal
 * debounce, and what makes `isAgentWaitingSession` true, so an idle session
 * raises `agent-waiting` rather than `terminal-waiting` (AP-TC-056 S003).
 */
const WAITING_DETECTION = { kind: "quiescence-only", debounceMs: 3000 };

/**
 * Split the free-form extra-arguments field into discrete argv tokens. A literal
 * splitter, not a shell: `;`, `&`, `|`, `$`, backticks and parentheses are all
 * ordinary characters here, which is the half of AP-NFR-001 the plugin owns.
 * Mirrors roubo-plugins/plugins/codex/src/tokenize.ts.
 */
function tokenize(extraArgs) {
  const tokens = [];
  let current = "";
  let started = false;

  const flush = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  for (let i = 0; i < extraArgs.length; i += 1) {
    const char = extraArgs[i];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      flush();
      continue;
    }

    if (char === "\\") {
      const next = extraArgs[i + 1];
      if (next === undefined) {
        throw new Error("codex e2e overlay: extra arguments end with a dangling backslash.");
      }
      current += next;
      started = true;
      i += 1;
      continue;
    }

    if (char === "'") {
      const end = extraArgs.indexOf("'", i + 1);
      if (end === -1) throw new Error("codex e2e overlay: unbalanced single quote.");
      current += extraArgs.slice(i + 1, end);
      started = true;
      i = end;
      continue;
    }

    if (char === '"') {
      started = true;
      let j = i + 1;
      let closed = false;
      for (; j < extraArgs.length; j += 1) {
        const inner = extraArgs[j];
        if (inner === "\\") {
          const next = extraArgs[j + 1];
          if (next === '"' || next === "\\") {
            current += next;
            j += 1;
          } else {
            current += inner;
          }
          continue;
        }
        if (inner === '"') {
          closed = true;
          break;
        }
        current += inner;
      }
      if (!closed) throw new Error("codex e2e overlay: unbalanced double quote.");
      i = j;
      continue;
    }

    current += char;
    started = true;
  }

  flush();
  return tokens;
}

/**
 * One closed-choice field. An absent, null or empty value reads as that field's
 * manifest default; an unrecognised one is rejected rather than passed through
 * as an opaque argv token.
 */
function readChoice(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new Error(
    `codex e2e overlay: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
}

/**
 * The generated argv: `--model`, the three `-c` config overrides,
 * `--strict-config`, then the tokenized extra arguments. The ORDER is the
 * contract AP-TC-056 S001 and AP-TC-105 S005 assert: generated flags first, the
 * user's extra tokens after them, each flag and each value its own argv entry
 * (never `--model=gpt-5.2-codex`, never one joined string).
 *
 * Mirrors roubo-plugins/plugins/codex/src/translate-launch.ts `buildArgs`,
 * including `--strict-config` and the `omitPolicyAxes` carve-out a permission
 * posture triggers.
 */
function buildArgs(config, opts = {}) {
  const args = [];

  const model = readChoice(config.model, MODELS, "model", DEFAULT_MODEL);
  if (model !== "default") args.push("--model", model);

  const effort = readChoice(config.effort, EFFORTS, "effort", DEFAULT_EFFORT);
  args.push("-c", `model_reasoning_effort=${effort}`);

  if (!opts.omitPolicyAxes) {
    const approvalPolicy = readChoice(
      config.approvalPolicy,
      APPROVAL_POLICIES,
      "approvalPolicy",
      DEFAULT_APPROVAL_POLICY,
    );
    args.push("-c", `approval_policy=${approvalPolicy}`);

    const sandbox = readChoice(config.sandbox, SANDBOXES, "sandbox", DEFAULT_SANDBOX);
    args.push("-c", `sandbox_mode=${sandbox}`);
  }

  args.push("--strict-config");

  const extraArgs = config.extraArgs;
  if (extraArgs !== undefined && extraArgs !== null) {
    if (typeof extraArgs !== "string") {
      throw new Error(
        `codex e2e overlay: "extraArgs" must be a string, but it was ${typeof extraArgs}.`,
      );
    }
    args.push(...tokenize(extraArgs));
  }

  return args;
}

/**
 * The project's posture, when it has chosen one. This overlay declares no
 * `permissions` capability (the real plugin's posture table is not on the
 * AP-US-009 journey), but a posture the host layers on still has to drop the two
 * policy axes rather than emit a second `approval_policy` override.
 */
function readPosture(permissions) {
  if (permissions === undefined || permissions === null) return undefined;
  if (typeof permissions !== "object" || Array.isArray(permissions)) return undefined;
  const posture = permissions.posture;
  return typeof posture === "string" && posture !== "" ? posture : undefined;
}

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => {
  const config = (params && params.config) || {};
  const posture = readPosture(config.permissions);
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    // No `--session-id` analogue: Codex has none, so the generated flags ARE the
    // whole argv and the host appends the initial prompt (if any) after them as
    // the last positional.
    args: buildArgs(config, { omitPolicyAxes: posture !== undefined }),
    initialPrompt: INITIAL_PROMPT,
    capabilities: { versionProbe: VERSION_PROBE, waitingDetection: WAITING_DETECTION },
  };
});

connection.listen();
