#!/usr/bin/env node
// AgentIdentifierGuard (issue #521, AP-NFR-006). #521 removed the built-in
// Claude Code launch path, so every agent launch now goes through an agent
// plugin's declarative launch descriptor. This guard makes that permanent: it
// fails the build if core (server/ + shared/) regrows knowledge of a specific
// AI coding agent, outside the bundled plugins.
//
// Three rule sets:
//
//   1. Agent-specific identifier. A declaration, property, or member access
//      whose NAME embeds a vendor agent name (claude / codex), e.g.
//      `ClaudeCodeSettings`, `getClaudeBinary`, `writeClaudeSettingsLocal`,
//      `settings.claudeCode`, `codexBinary`. Core names no agent, so an
//      identifier that does means an agent-specific branch has come back.
//
//   2. Inline agent CLI flag. A native agent CLI flag assembled in core
//      (--enable-auto-mode, --permission-mode, --dangerously-skip-permissions,
//      --full-auto, --ask-for-approval,
//      --dangerously-bypass-approvals-and-sandbox). argv belongs to the
//      plugin's descriptor; core resolving a flag itself is the built-in path
//      growing back (AP-FR-019).
//
//   3. Agent-name string DISPATCH. An equality comparison or `case` label
//      against a string naming an agent, e.g. `command === "claude"`,
//      `case "codex":`. Rule 1 cannot see this (it blanks string contents by
//      design, see below), yet it is precisely the branch #521 deleted from
//      `server/routes/terminal.ts` and `server/services/terminal.ts`. Naming an
//      agent in a string is fine; BRANCHING on that name is the built-in path
//      regrowing under a different spelling (AP-FR-019, AP-TC-104).
//
// Why the rules read different sources, and why that is what keeps the rule-set
// narrow without a pile of file allowlists:
//
//   - Rule 1 runs against source with comments AND string-literal CONTENTS
//     blanked. Everything core legitimately keeps that mentions an agent by
//     name is a STRING, never an identifier: `wellKnownPathsFor`'s install
//     table (`case "claude":`, `~/.claude/local/claude`), the published
//     `/claude-notification` hook endpoint every http-hook descriptor POSTs to,
//     the `.claude/settings.local.json` path `injectPermissions` writes, the
//     legacy settings-file key the upgrade notice reads. Blanking string
//     contents therefore needs no allowlist at all, and it cannot hide a real
//     identifier, because an identifier is code. Template-literal `${...}`
//     interpolations are NOT blanked, so an identifier inside one still flags.
//   - Rules 2 and 3 run against comment-stripped source with strings intact,
//     because a CLI flag IS a string literal and so is a dispatch operand.
//
// Rule 3 is the one rule that needs an allowlist, and it is deliberately a
// single file: `wellKnownPathsFor`'s host install-location table genuinely
// switches on an agent CLI's own basename to know where that CLI installs
// itself. That is host knowledge, not launch knowledge, and it is the sanctioned
// survivor `CLAUDE.md` names. Allowlisting one file mirrors the component guard,
// whose own rule 1 allowlists exactly one file for the same reason.
//
// Every rule ignores comments, so prose documenting the forbidden patterns (this
// header included) is never itself a violation. Stripping a comment can only
// ever remove a would-be violation from prose, never hide real code, so the
// guard stays sound.
//
// Run with: npm run lint:agent-guard

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOTS = ["server", "shared"];

// Rule 1: an identifier token embedding a vendor agent name. Anchored on word
// boundaries so it matches the whole identifier, and case-insensitive so both
// `ClaudeCodeSettings` and `claudeCode` are caught.
const AGENT_IDENTIFIER = /\b[A-Za-z0-9_$]*(?:claude|codex)[A-Za-z0-9_$]*\b/gi;

// Rule 2: a native agent CLI flag assembled inline in core.
const AGENT_CLI_FLAGS = [
  "--enable-auto-mode",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--full-auto",
  "--ask-for-approval",
  "--dangerously-bypass-approvals-and-sandbox",
];
// Escape EVERY regex metacharacter, not just the `-` these flags happen to
// contain. Escaping one character is a sanitiser that silently stops being one
// the moment somebody adds a flag containing anything else, and a partial escape
// that leaves backslashes alone is the classic incomplete-sanitization defect.
// A full escape costs nothing here and cannot rot.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const AGENT_CLI_FLAG = new RegExp(`(${AGENT_CLI_FLAGS.map(escapeRegExp).join("|")})\\b`);

// Rule 3: an equality comparison or `case` label against a string naming an
// agent. Three alternatives (operand on the right, a `case` label, operand on
// the left); each carries its own quote-delimiter backreference, so the group
// numbers are 1, 2, 3 in source order.
const AGENT_STRING = `[^'"\`\\n]*(?:claude|codex)[^'"\`\\n]*`;
const AGENT_STRING_DISPATCH = new RegExp(
  [
    `[!=]==?\\s*(['"\`])${AGENT_STRING}\\1`,
    `\\bcase\\s+(['"\`])${AGENT_STRING}\\2`,
    `(['"\`])${AGENT_STRING}\\3\\s*[!=]==?`,
  ].join("|"),
  "gi",
);

// The one sanctioned dispatch: the host install-location table keys on an agent
// CLI's own basename to know where that CLI installs itself (CLAUDE.md).
const AGENT_STRING_DISPATCH_ALLOWLIST = new Set(["server/services/env.ts"]);

/**
 * Blank // line comments and block comments, preserving newlines so reported
 * line numbers stay correct.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

/**
 * Blank comments AND the CONTENTS of string literals, preserving newlines and
 * the delimiters themselves so line numbers and token shape survive. Template
 * literal `${...}` interpolations are left intact: they hold real code, and an
 * agent-specific identifier inside one must still be caught.
 *
 * Hand-rolled rather than regex-based because a regex cannot track which
 * quoting context a `//` or a quote character is in, and getting that wrong in
 * the unsound direction (treating code as a string) would blind the guard.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  // Depth of `${` interpolations currently open, so a nested template inside an
  // interpolation returns to the right state.
  const templateStack = [];

  const blank = (ch) => (ch === "\n" ? "\n" : " ");

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Comments.
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += blank(source[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }

    // Quoted strings: keep the delimiters, blank the contents.
    if (ch === '"' || ch === "'") {
      out += ch;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        // An unterminated quote must not swallow the rest of the file.
        if (source[i] === "\n") break;
        out += " ";
        i++;
      }
      if (i < source.length && source[i] === ch) {
        out += ch;
        i++;
      }
      continue;
    }

    // Template literals: blank the literal spans, keep `${...}` code.
    if (ch === "`") {
      out += ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === "`") {
          out += "`";
          i++;
          break;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          out += "${";
          i += 2;
          templateStack.push(1);
          break;
        }
        out += blank(source[i]);
        i++;
      }
      continue;
    }

    // Inside an interpolation: `}` at depth 0 closes it and resumes the
    // enclosing template's literal span.
    if (templateStack.length > 0 && (ch === "{" || ch === "}")) {
      const depth = templateStack[templateStack.length - 1];
      if (ch === "{") {
        templateStack[templateStack.length - 1] = depth + 1;
        out += ch;
        i++;
        continue;
      }
      if (depth === 1) {
        templateStack.pop();
        out += "}";
        i++;
        // Resume the template's literal span.
        while (i < source.length) {
          if (source[i] === "\\") {
            out += "  ";
            i += 2;
            continue;
          }
          if (source[i] === "`") {
            out += "`";
            i++;
            break;
          }
          if (source[i] === "$" && source[i + 1] === "{") {
            out += "${";
            i += 2;
            templateStack.push(1);
            break;
          }
          out += blank(source[i]);
          i++;
        }
        continue;
      }
      templateStack[templateStack.length - 1] = depth - 1;
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Scan the given files for agent-specific-knowledge violations.
 *
 * @param {string[]} files - repo-relative file paths to scan.
 * @param {(file: string) => string} readFn - reads a file's contents.
 * @returns {{ file: string, line: number, text: string, reason: string }[]}
 */
export function scanFiles(files, readFn) {
  const findings = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFn(file);
    } catch {
      continue;
    }

    const rawLines = contents.split("\n");
    const identifierLines = stripCommentsAndStrings(contents).split("\n");
    const flagLines = stripComments(contents).split("\n");

    // Rule 1: an agent-specific identifier.
    for (let i = 0; i < identifierLines.length; i++) {
      for (const match of identifierLines[i].matchAll(AGENT_IDENTIFIER)) {
        findings.push({
          file,
          line: i + 1,
          text: rawLines[i].trim(),
          reason:
            `agent-specific identifier '${match[0]}': core (server/ + shared/) names no ` +
            "AI coding agent. An agent launch is described by its plugin's launch " +
            "descriptor, never by a branch in core (AP-NFR-006, AP-FR-019).",
        });
      }
    }

    // Rule 2: a native agent CLI flag assembled inline in core.
    for (let i = 0; i < flagLines.length; i++) {
      const match = AGENT_CLI_FLAG.exec(flagLines[i]);
      if (match) {
        findings.push({
          file,
          line: i + 1,
          text: rawLines[i].trim(),
          reason:
            `inline agent CLI flag '${match[1]}': argv belongs to the agent plugin's ` +
            "launch descriptor, so core must not assemble an agent's own flags " +
            "(AP-NFR-006, AP-FR-019).",
        });
      }
    }

    // Rule 3: a dispatch branching on an agent's name as a string.
    if (!AGENT_STRING_DISPATCH_ALLOWLIST.has(file)) {
      for (let i = 0; i < flagLines.length; i++) {
        for (const match of flagLines[i].matchAll(AGENT_STRING_DISPATCH)) {
          findings.push({
            file,
            line: i + 1,
            text: rawLines[i].trim(),
            reason:
              `agent-name dispatch '${match[0].trim()}': core may NAME an agent in a ` +
              "string, but branching on that name is the built-in launch path " +
              "regrowing. Route the decision through the plugin's launch descriptor " +
              "instead (AP-NFR-006, AP-FR-019).",
          });
        }
      }
    }
  }
  return findings;
}

function listFiles() {
  // Track only committed/tracked files; mirrors what CI checks out. Exclude
  // tests (intentional-violation fixtures live in them) and the bundled plugins
  // tree (the one place agent-specific knowledge belongs).
  const output = execSync("git ls-files " + ROOTS.join(" "), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => !f.endsWith(".d.ts"))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
    .filter((f) => !f.includes("/plugins/") && !f.startsWith("plugins/"));
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = scanFiles(listFiles(), (f) => readFileSync(f, "utf8"));

  if (findings.length > 0) {
    console.error(
      `Found ${findings.length} agent-specific-knowledge violation(s). ` +
        "AP-NFR-006 requires core (server/ + shared/) to name no AI coding agent: " +
        "no agent-specific identifiers and no inline agent CLI flags, outside the " +
        "bundled plugins.\n",
    );
    for (const v of findings) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
      console.error(`    -> ${v.reason}`);
    }
    process.exit(1);
  }

  console.log("No agent-specific-knowledge violations found (core names no agent).");
}
