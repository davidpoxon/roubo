#!/usr/bin/env node
// PR guard against AI coding agent co-authorship (issue #391). Roubo commits and
// PRs carry the human author's identity only. This script fails a PR when any of
// its commit messages or its PR body credits an AI coding agent (Claude / Claude
// Code, Anthropic, GitHub Copilot, Cursor, Codex, OpenAI, ChatGPT, Gemini,
// Devin, etc.) as a co-author, or carries a known AI-attribution footer ("🤖
// Generated with [Claude Code]", "Generated with Claude Code", and friends).
//
// KEY DESIGN DECISION: this is a DENYLIST of AI-agent identities, NOT a blanket
// ban on `Co-Authored-By:` lines. Legitimate human pair-programming co-authors
// must still pass. A `Co-Authored-By:` line only fails when its name or email
// matches a known AI-agent signature in the denylist below. Standalone
// attribution-footer markers (the robot-emoji "Generated with" credit) fail on
// their own line, independent of any trailer.
//
// Scans two surfaces, mirroring how the workflow drives it:
//   1. every commit message in the PR range (BASE_SHA..HEAD), and
//   2. the PR body.
//
// Run with: npm run lint:no-ai-coauthor
// In CI the workflow passes BASE_SHA / HEAD_SHA and the PR body via the PR_BODY
// env var; locally it falls back to scanning origin/main..HEAD.

import { execFileSync } from "node:child_process";

// Tool-agnostic denylist of AI-agent co-author signatures. Each entry is a
// case-insensitive regex tested against the value of a `Co-Authored-By:` (or
// equivalent attribution) line, i.e. the `Name <email>` portion. Keep this list
// focused on AI coding agents so human co-authors are never matched.
const AI_COAUTHOR_PATTERNS = [
  /\bclaude\b/i, // Claude, Claude Code, claude-3, etc.
  /\banthropic\b/i, // Anthropic, noreply@anthropic.com
  /\bgithub copilot\b/i,
  /\bcopilot\b/i,
  /\bcursor\b/i,
  /\bcodex\b/i,
  /\bopenai\b/i,
  /\bchat ?gpt\b/i, // ChatGPT, Chat GPT
  /\bgpt-?\d/i, // GPT-4, GPT4, gpt-4o
  /\bgemini\b/i,
  /\bdevin\b/i,
];

// Standalone attribution-footer markers. These fail on any line that contains
// them, independent of whether the line is a `Co-Authored-By:` trailer. They
// cover the boilerplate credit footers AI agents append to commit/PR bodies.
const AI_FOOTER_PATTERNS = [
  /generated with \[?claude code/i, // "Generated with [Claude Code]" / "Generated with Claude Code"
  /generated with \[?claude/i,
  /🤖/, // robot-emoji credit
  /co-authored-by:\s*claude/i, // belt-and-braces for the canonical footer trailer
];

// Matches a `Co-Authored-By:` trailer and captures the identity portion.
const COAUTHOR_LINE = /^\s*co-authored-by:\s*(.+?)\s*$/i;

/**
 * Find AI-agent co-authorship / attribution violations across a set of text
 * sources.
 *
 * Each source is `{ label, text }` where `label` names the surface (e.g. a
 * commit short-sha + subject, or "PR body") and `text` is the full message. The
 * function scans line by line and reports:
 *   - any `Co-Authored-By:` line whose identity matches an AI-agent pattern, and
 *   - any line containing a known AI-attribution footer marker.
 *
 * Human `Co-Authored-By:` lines (identity matches no AI pattern) are left alone.
 *
 * @param {Array<{label: string, text: string}>} sources
 * @returns {Array<{label: string, line: number, text: string, reason: string}>}
 */
export function findAiCoauthorViolations(sources) {
  const violations = [];
  if (!Array.isArray(sources)) {
    return violations;
  }

  for (const source of sources) {
    if (!source || typeof source.text !== "string") {
      continue;
    }
    const label = typeof source.label === "string" ? source.label : "(unknown)";
    const lines = source.text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }

      // 1. Co-Authored-By trailer with an AI-agent identity.
      const coauthor = line.match(COAUTHOR_LINE);
      if (coauthor) {
        const identity = coauthor[1];
        const matched = AI_COAUTHOR_PATTERNS.find((re) => re.test(identity));
        if (matched) {
          violations.push({
            label,
            line: i + 1,
            text: trimmed,
            reason: `AI-agent co-author (matched ${matched})`,
          });
          continue;
        }
      }

      // 2. Standalone AI-attribution footer marker.
      const footer = AI_FOOTER_PATTERNS.find((re) => re.test(line));
      if (footer) {
        violations.push({
          label,
          line: i + 1,
          text: trimmed,
          reason: `AI-attribution footer (matched ${footer})`,
        });
      }
    }
  }

  return violations;
}

/**
 * Build the `{ label, text }` sources for the current PR: one per commit message
 * in the range plus, optionally, the PR body.
 *
 * @param {{ baseSha?: string, headSha?: string, prBody?: string }} input
 * @returns {Array<{label: string, text: string}>}
 */
export function collectSources({ baseSha, headSha, prBody } = {}) {
  const range = baseSha && headSha ? `${baseSha}..${headSha}` : (baseSha ?? "origin/main..HEAD");

  const sources = [];

  let shas;
  try {
    // execFileSync (not execSync) runs git directly without a shell, so the
    // range and SHA values are passed as argv elements and can never be
    // interpreted as shell syntax. `--` terminates option parsing so a value
    // that happens to start with `-` is still treated as a revision, not a flag.
    shas = execFileSync("git", ["log", "--no-merges", "--format=%H", range, "--"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Capture git's stderr (in err.stderr below) instead of letting it leak
      // to the parent process; an invalid range surfaces via the thrown Error.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    // A missing or invalid range (e.g. origin/main not fetched locally, or a
    // bad revision) should be a loud, actionable failure rather than a silent
    // pass. Surface git's own stderr, which carries the precise reason.
    const detail = (err.stderr ?? "").toString().trim() || err.message;
    throw new Error(`Failed to list commits for range "${range}": ${detail}`, { cause: err });
  }

  for (const sha of shas.split("\n").filter(Boolean)) {
    const subject = execFileSync("git", ["log", "-1", "--format=%s", sha, "--"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const body = execFileSync("git", ["log", "-1", "--format=%B", sha, "--"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const short = sha.slice(0, 7);
    sources.push({ label: `commit ${short} (${subject})`, text: body });
  }

  if (typeof prBody === "string" && prBody.trim() !== "") {
    sources.push({ label: "PR body", text: prBody });
  }

  return sources;
}

function readPrBody() {
  // The PR body arrives via the PR_BODY env var, set by the workflow from
  // github.event.pull_request.body. There is intentionally no file-path input:
  // reading an env-supplied path would be a needless injection sink, and the
  // body is always small enough to pass through the environment directly.
  if (typeof process.env.PR_BODY === "string" && process.env.PR_BODY !== "") {
    return process.env.PR_BODY;
  }
  return "";
}

function main() {
  const sources = collectSources({
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
    prBody: readPrBody(),
  });

  const violations = findAiCoauthorViolations(sources);

  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} AI coding agent co-authorship violation(s). ` +
        "Roubo commits and PRs carry the human author's identity only.\n" +
        "Remove the AI co-author trailer or attribution footer, then amend the commit " +
        "(or edit the PR body) and re-push.\n",
    );
    for (const v of violations) {
      console.error(`  ${v.label} line ${v.line}: ${v.text}  [${v.reason}]`);
    }
    process.exit(1);
  }

  console.log("No AI coding agent co-authorship found.");
}

// Run the CLI only when invoked directly, not when imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("check-ai-coauthorship.mjs")) {
  main();
}
