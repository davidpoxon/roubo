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
 * The stub CLI the host spawns. Deliberately NOT `claude`: `importLoginShellEnv()`
 * prepends `~/.local/bin`, so a real Claude Code install would otherwise win the
 * lookup and the guard would drive the real CLI.
 */
const COMMAND = "roubo-e2e-claude-stub";

/** Mirrors the real plugin's SETTINGS_REL_PATH. */
const SETTINGS_REL_PATH = ".claude/settings.local.json";

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

/**
 * Mirrors the real plugin's PERMISSIONS_CAPABILITY, both axes.
 *
 * Every posture binds through argv alone, because Claude Code's native mechanism
 * for that axis is `--permission-mode`. The fine-grained rules are the other
 * axis and they do need a file, which is why `rules` declares the
 * workspace-write carrier and opts into resync: without it `applyProjectPermissions`
 * reports carrier "none" and skips every bench, so the AP-TC-101 resync journey
 * has nothing to observe.
 */
const PERMISSIONS_CAPABILITY = {
  postures: {
    "read-only": { args: ["--permission-mode", "plan"] },
    guarded: { args: ["--permission-mode", "manual"] },
    "auto-edit": { args: ["--permission-mode", "acceptEdits"] },
    "full-auto": { args: ["--permission-mode", "auto"] },
  },
  rules: { carrier: "workspace-write", resync: true },
};

/**
 * Mirrors the real plugin's NOTIFICATION_WIRING.
 *
 * Catch-all with no matcher, correlated on the CLI's own `session_id`, which is
 * the uuid the host handed it as `--session-id`. Declaring this is what makes a
 * session hook-wired: without it `isHookNotificationEligible` returns false and
 * POST /api/hooks/claude-notification answers 400, so the AP-TC-065 / AP-TC-099
 * waiting-notification journeys cannot be driven at all.
 *
 * `Notification` is SET rather than unioned, so a stale registration can never
 * survive, and only that key is touched (AP-TC-098).
 */
const NOTIFICATION_WIRING = {
  kind: "http-hook",
  event: "waiting",
  carrier: {
    workspaceWrite: {
      relPath: SETTINGS_REL_PATH,
      format: "json",
      ops: [
        {
          op: "set",
          path: "hooks.Notification",
          value: [
            {
              hooks: [
                { type: "http", url: "http://localhost:{{port}}/api/hooks/claude-notification" },
              ],
            },
          ],
        },
      ],
    },
  },
  correlation: { field: "session_id", source: "agent-native" },
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

/** Every string in one rule list, ignoring anything that is not a string. */
function readRuleList(value) {
  return Array.isArray(value) ? value.filter((rule) => typeof rule === "string") : [];
}

/** The project's fine-grained rules, when it has any. Mirrors readRules. */
function readRules(permissions) {
  if (permissions === undefined || permissions === null) return undefined;
  if (typeof permissions !== "object" || Array.isArray(permissions)) return undefined;
  const raw = permissions.rules;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return {
    allow: readRuleList(raw.allow),
    ask: readRuleList(raw.ask),
    deny: readRuleList(raw.deny),
  };
}

/**
 * The rules write, or undefined when there is nothing to write. Mirrors
 * buildRulesWrite, including the allow/deny/ask op ordering, which is what makes
 * a fresh settings file byte-identical to the built-in writer's (AP-TC-097).
 */
function buildRulesWrite(rules) {
  if (!rules) return undefined;
  const ops = [];
  if (rules.allow.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.allow", values: rules.allow });
  }
  if (rules.deny.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.deny", values: rules.deny });
  }
  if (rules.ask.length > 0) {
    ops.push({ op: "unionArray", path: "permissions.ask", values: rules.ask });
  }
  if (ops.length === 0) return undefined;
  return { relPath: SETTINGS_REL_PATH, format: "json", ops };
}

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => {
  const config = (params && params.config) || {};
  const posture = readPosture(config.permissions);
  const rulesWrite = buildRulesWrite(readRules(config.permissions));
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
      // The rules write comes first so a fresh settings file gets `permissions`
      // before `hooks`, byte-for-byte what the built-in integration produces for
      // the same inputs (AP-TC-097).
      ...(rulesWrite !== undefined && { workspaceWrites: [rulesWrite] }),
      notification: NOTIFICATION_WIRING,
      versionProbe: VERSION_PROBE,
      permissions: PERMISSIONS_CAPABILITY,
    },
  };
});

connection.listen();
