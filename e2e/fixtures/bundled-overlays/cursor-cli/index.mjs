// E2E overlay runtime for the `cursor-cli` agent plugin slot (APCC-TC-038,
// APCC-TC-011, APCC-TC-046).
//
// SOURCE OF TRUTH: roubo-plugins/plugins/cursor-cli/src/translate-launch.ts and
// src/tokenize.ts. The argv mapping, the tokenizer, the worktree guard, the
// posture table, the rule translation, the project rules write, the `stop` hook
// notification wiring and its waiting detection below are a
// MIRROR of that module, kept here only because roubo's e2e suite cannot depend
// on the roubo-plugins workspace (the plugins there build against the published
// SDK, and the Cursor plugin is not yet in any catalog). Re-copy them whenever
// the shipped module changes.
//
// PARTIAL CIRCULARITY, stated plainly: because this overlay implements the
// mapping itself, the APCC-TC-038 guard cannot prove the real plugin's posture
// flags or rule translation; roubo-plugins unit-covers those
// (translate-launch.test.ts, APCC-TC-039 to APCC-TC-042). What the guard does
// prove is the HOST-side integrated path: that the permissions screen gates its
// axes on what the plugin declares, that the posture and rules it saves reach
// the launch, that the host appends the posture's declared args to the spawned
// argv, and that the host executes the declared write into the bench workspace.
// For APCC-TC-011 the model flag's mapping is unit-covered there too; the guard
// proves that the probed model id the AI Agents form saves reaches the spawned
// argv unchanged.
//
// For APCC-TC-046 the notification wiring is unit-covered there as well (under
// "cursor-cli notification wiring (APCC-FR-017)"); the guard proves that the
// host installs the notifier, writes the hook registration into the bench's own
// worktree, registers the correlation token, and raises the notification on the
// bench that owns the session and on no other.
//
// ESM because the manifest entry is `./index.mjs`; `vscode-jsonrpc/node`
// resolves from roubo/node_modules.

import * as rpc from "vscode-jsonrpc/node";

/**
 * The stub CLI the host spawns. Deliberately NOT `agent`: see the stub's own
 * header (e2e/fixtures/bin/roubo-e2e-cursor-stub).
 */
const COMMAND = "roubo-e2e-cursor-stub";

/** Mirrors the real plugin's RULES_REL_PATH. */
const RULES_REL_PATH = ".cursor/cli.json";

/** Mirrors the real plugin's MAX_PROMPT_LENGTH. */
const MAX_PROMPT_LENGTH = 100_000;

/** Matches the manifest's `agentCompatibility` window exactly. */
const VERSION_PROBE = {
  args: ["--version"],
  parse: "semver",
  minVersion: "2026.09.08",
  testedCeiling: "2026.09.15",
};

/**
 * Mirrors the real plugin's NOTIFICATION_WIRING verbatim: a `stop` hook
 * registered in the worktree's `.cursor/hooks.json`, the notifier run with the
 * Roubo session id as its one argument, and the event JSON on its standard
 * input.
 */
const NOTIFICATION_WIRING = {
  kind: "file-notifier",
  event: "turn-complete",
  carrier: {
    workspaceWrite: {
      relPath: ".cursor/hooks.json",
      format: "json",
      ops: [
        { op: "set", path: "version", value: 1 },
        {
          op: "upsertArray",
          path: "hooks.stop",
          value: { command: "{{notifierCommand}}" },
          match: { key: "command", contains: "{{notifier}}" },
        },
      ],
    },
    args: ["{{notifier}}", "{{sessionId}}"],
  },
  payload: "json-stdin",
  correlation: { source: "template", template: "{{sessionId}}" },
};

/** Mirrors the real plugin's WAITING_DETECTION: the hook, with a 3000ms fallback. */
const WAITING_DETECTION = { kind: "hook-driven", quiescenceFallbackMs: 3000 };

const MODES = ["agent", "plan", "ask"];
const DEFAULT_MODE = "agent";

/** Mirrors the real plugin's worktree flags. */
const WORKTREE_LONG_FLAGS = ["--worktree", "--worktree-base", "--skip-worktree-setup"];
const WORKTREE_SHORT_FLAG = "-w";

/** Mirrors the real plugin's PERMISSIONS_CAPABILITY. */
const PERMISSIONS_CAPABILITY = {
  postures: {
    "read-only": { args: ["--mode", "plan"] },
    guarded: { args: ["--sandbox", "enabled"] },
    "auto-edit": { args: ["--auto-review", "--sandbox", "enabled"] },
    "full-auto": { args: ["--force", "--sandbox", "disabled"] },
  },
  rules: { carrier: "workspace-write", resync: true },
};

const POSTURES = Object.keys(PERMISSIONS_CAPABILITY.postures);

/** Mirrors the real plugin's CURSOR_RULE_TYPES. */
const CURSOR_RULE_TYPES = {
  Shell: "Shell",
  Read: "Read",
  Write: "Write",
  Bash: "Shell",
  Edit: "Write",
  MultiEdit: "Write",
};

function readChoice(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new Error(
    `cursor e2e overlay: "${field}" must be one of ${allowed.join(", ")}, but it was ` +
      `${JSON.stringify(value)}.`,
  );
}

/** Mirrors the real plugin's `postureSetsMode`. */
function postureSetsMode(posture) {
  if (posture === undefined) return false;
  return PERMISSIONS_CAPABILITY.postures[posture]?.args.includes("--mode") ?? false;
}

/**
 * Split the free-form extra-arguments field into discrete argv tokens. A literal
 * splitter, not a shell. Mirrors roubo-plugins/plugins/cursor-cli/src/tokenize.ts.
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
        throw new Error("cursor e2e overlay: extra arguments end with a dangling backslash.");
      }
      current += next;
      started = true;
      i += 1;
      continue;
    }

    if (char === "'") {
      const end = extraArgs.indexOf("'", i + 1);
      if (end === -1) throw new Error("cursor e2e overlay: unbalanced single quote.");
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
      if (!closed) throw new Error("cursor e2e overlay: unbalanced double quote.");
      i = j;
      continue;
    }

    current += char;
    started = true;
  }

  flush();
  return tokens;
}

function worktreeFlagOf(arg) {
  for (const flag of WORKTREE_LONG_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
  }
  if (arg.startsWith(WORKTREE_SHORT_FLAG)) return WORKTREE_SHORT_FLAG;
  return undefined;
}

/**
 * Mirrors the real plugin's `buildArgs`: the selected model id UNCHANGED as one
 * `--model` pair (never given bracketed parameters, never reduced to a base
 * name), `--mode` only when it is not the `agent` default and no posture sets
 * its own, then the tokenized extra arguments, then the worktree guard over the
 * whole list.
 */
function buildArgs(config, opts) {
  const args = [];

  const model = config.model;
  if (model !== undefined && model !== null) {
    if (typeof model !== "string") {
      throw new Error(`cursor e2e overlay: "model" must be a string, but it was ${typeof model}.`);
    }
    if (model !== "") args.push("--model", model);
  }

  const mode = readChoice(config.mode, MODES, "mode", DEFAULT_MODE);
  if (mode !== DEFAULT_MODE && !opts.omitMode) args.push("--mode", mode);

  const extraArgs = config.extraArgs;
  if (extraArgs !== undefined && extraArgs !== null) {
    if (typeof extraArgs !== "string") {
      throw new Error(
        `cursor e2e overlay: "extraArgs" must be a string, but it was ${typeof extraArgs}.`,
      );
    }
    args.push(...tokenize(extraArgs));
  }

  for (const arg of args) {
    const flag = worktreeFlagOf(arg);
    if (flag !== undefined) {
      throw new Error(
        `cursor e2e overlay: the "${flag}" flag is not allowed, because Roubo owns the worktree.`,
      );
    }
  }

  return args;
}

/** Mirrors the real plugin's `readPermissions`, `readPosture` and `readRules`. */
function readPermissions(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('cursor e2e overlay: "permissions" must be an object.');
  }
  let posture;
  if (value.posture !== undefined && value.posture !== null) {
    if (!POSTURES.includes(value.posture)) {
      throw new Error(
        `cursor e2e overlay: "permissions.posture" must be one of ${POSTURES.join(", ")}, ` +
          `but it was ${JSON.stringify(value.posture)}.`,
      );
    }
    posture = value.posture;
  }
  let rules;
  const raw = value.rules;
  if (raw !== undefined && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    rules = {
      allow: readRuleList(raw.allow),
      ask: readRuleList(raw.ask),
      deny: readRuleList(raw.deny),
    };
  }
  return { posture, rules };
}

function readRuleList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/** Mirrors the real plugin's `toCursorRule`. */
function toCursorRule(rule) {
  const match = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!match) return undefined;
  const type = CURSOR_RULE_TYPES[match[1]];
  if (type === undefined) return undefined;
  return `${type}(${match[2] ?? "*"})`;
}

function toCursorRules(rules) {
  const out = [];
  for (const rule of rules) {
    const typed = toCursorRule(rule);
    if (typed !== undefined && !out.includes(typed)) out.push(typed);
  }
  return out;
}

/**
 * Mirrors the real plugin's `buildRulesWrite`: allow and deny only, as
 * `unionArray` ops against the parsed existing file. An ask rule is never
 * written, because Cursor has no ask tier.
 */
function buildRulesWrite(rules) {
  if (!rules) return undefined;
  const ops = [];
  const allow = toCursorRules(rules.allow);
  if (allow.length > 0) ops.push({ op: "unionArray", path: "permissions.allow", values: allow });
  const deny = toCursorRules(rules.deny);
  if (deny.length > 0) ops.push({ op: "unionArray", path: "permissions.deny", values: deny });
  if (ops.length === 0) return undefined;
  return { relPath: RULES_REL_PATH, format: "json", ops };
}

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("translateLaunch", (params) => {
  const config = (params && params.config) || {};
  const permissions = readPermissions(config.permissions);
  const rulesWrite = buildRulesWrite(permissions?.rules);
  return {
    schemaVersion: 1,
    kind: "agent-launch",
    command: COMMAND,
    // The posture flags are not pushed here: the host appends the selected
    // posture's declared args, as it does for every agent plugin.
    args: buildArgs(config, { omitMode: postureSetsMode(permissions?.posture) }),
    initialPrompt: { mode: "argv-positional", maxLength: MAX_PROMPT_LENGTH },
    capabilities: {
      ...(rulesWrite !== undefined && { workspaceWrites: [rulesWrite] }),
      notification: NOTIFICATION_WIRING,
      versionProbe: VERSION_PROBE,
      waitingDetection: WAITING_DETECTION,
      permissions: PERMISSIONS_CAPABILITY,
    },
  };
});

connection.listen();
