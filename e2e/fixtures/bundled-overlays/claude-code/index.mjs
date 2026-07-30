// E2E overlay runtime for the `claude-code` agent plugin slot (issue #531).
//
// SOURCE OF TRUTH: roubo-plugins/plugins/claude-code/src/translate-launch.ts and
// roubo-plugins/plugins/claude-code/src/tokenize.ts. The flag ordering, the
// sentinel handling and the tokenizer below are a MIRROR of those two modules,
// kept here only because roubo's e2e suite cannot depend on the roubo-plugins
// workspace (the plugins there build against the published SDK).
//
// PARTIAL CIRCULARITY, stated plainly: because this overlay implements the argv
// mapping itself, the AP-TC-087 guard cannot prove the real plugin's `buildArgs`.
// That mapping is unit-covered in roubo-plugins (translate-launch.test.ts,
// tokenize.test.ts). What this guard does prove is the HOST-side integrated path:
// that the AI Agents form persists app-level defaults, that a launch resolves
// them through the four-layer config, and that they reach the spawned CLI as
// separate argv tokens with no shell interpretation.
//
// Modelled on server/services/__fixtures__/plugins/agent-echo/index.cjs for the
// JSON-RPC shape; ESM because the manifest entry is `./index.mjs` and
// `vscode-jsonrpc/node` resolves from roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

/**
 * The stub CLI the host spawns. Deliberately NOT `claude`: `resolveShellPath()`
 * prepends `~/.local/bin`, so a real Claude Code install would otherwise win the
 * lookup and the guard would drive the real CLI.
 */
const COMMAND = "roubo-e2e-claude-stub";

/** Mirrors the real plugin's MAX_PROMPT_LENGTH. */
const MAX_PROMPT_LENGTH = 100_000;

const MODELS = ["default", "opus", "sonnet", "haiku"];
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
const MODES = ["default", "plan", "auto", "acceptEdits", "manual"];

/** Mirrors the real plugin's VERSION_PROBE, retargeted at the stub binary. */
const VERSION_PROBE = {
  args: ["--version"],
  parse: "semver",
  minVersion: "2.1.111",
  testedCeiling: "2.1.207",
};

/** Mirrors the real plugin's PERMISSIONS_CAPABILITY posture bindings. */
const PERMISSIONS_CAPABILITY = {
  postures: {
    "read-only": { args: ["--permission-mode", "plan"] },
    guarded: { args: ["--permission-mode", "manual"] },
    "auto-edit": { args: ["--permission-mode", "acceptEdits"] },
    "full-auto": { args: ["--permission-mode", "auto"] },
  },
};

/**
 * Split the free-form extra-arguments field into discrete argv tokens. A literal
 * splitter, not a shell: `;`, `&`, `|`, `$`, backticks and parentheses are all
 * ordinary characters here, which is the half of AP-NFR-001 the plugin owns.
 * Mirrors roubo-plugins/plugins/claude-code/src/tokenize.ts.
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
        throw new Error("claude-code e2e overlay: extra arguments end with a dangling backslash.");
      }
      current += next;
      started = true;
      i += 1;
      continue;
    }

    if (char === "'") {
      const end = extraArgs.indexOf("'", i + 1);
      if (end === -1) throw new Error("claude-code e2e overlay: unbalanced single quote.");
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
      if (!closed) throw new Error("claude-code e2e overlay: unbalanced double quote.");
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
 * One closed-choice field. An absent, null or empty value reads as the field's
 * sentinel default; an unrecognised one is rejected rather than passed through as
 * an opaque argv token.
 */
function readChoice(value, allowed, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new Error(
    `claude-code e2e overlay: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
}

/**
 * The generated argv prefix: `--model`, `--effort`, `--permission-mode`, then the
 * tokenized extra arguments. The ORDER is the contract AP-TC-087 S008 asserts:
 * generated flags first, the user's extra tokens after them, each value its own
 * argv entry (never `--model=opus`, never one joined string).
 */
function buildArgs(config, opts = {}) {
  const args = [];

  const model = readChoice(config.model, MODELS, "model");
  if (model !== undefined && model !== "default") args.push("--model", model);

  const effort = readChoice(config.effort, EFFORTS, "effort");
  if (effort !== undefined && effort !== "default") args.push("--effort", effort);

  const mode = opts.omitMode ? undefined : readChoice(config.mode, MODES, "mode");
  if (mode !== undefined && mode !== "default") args.push("--permission-mode", mode);

  const extraArgs = config.extraArgs;
  if (extraArgs !== undefined && extraArgs !== null) {
    if (typeof extraArgs !== "string") {
      throw new Error(
        `claude-code e2e overlay: "extraArgs" must be a string, but it was ${typeof extraArgs}.`,
      );
    }
    args.push(...tokenize(extraArgs));
  }

  return args;
}

/** The project's posture, when it has chosen one. Mirrors readPermissions. */
function readPosture(permissions) {
  if (permissions === undefined || permissions === null) return undefined;
  if (typeof permissions !== "object" || Array.isArray(permissions)) return undefined;
  const posture = permissions.posture;
  return typeof posture === "string" ? posture : undefined;
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
    // `--session-id <uuid>` is the stable argv tail; the host appends the initial
    // prompt (if any) after it as the last positional.
    args: [
      ...buildArgs(config, { omitMode: posture !== undefined }),
      "--session-id",
      "{{sessionId}}",
    ],
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
    capabilities: {
      // No `notification` wiring: the real plugin declares an http-hook carrier
      // write, but AP-TC-087 asserts nothing about hooks and the extra workspace
      // write would only add a failure mode to this guard.
      versionProbe: VERSION_PROBE,
      permissions: PERMISSIONS_CAPABILITY,
    },
  };
});

connection.listen();
