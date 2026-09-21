#!/usr/bin/env node
// RepoReferenceGuard. Fails when a tracked file names a repository that this
// public repository must not reference: in a comment, a link, an issue citation
// (`<name>#N`), or a fixture value.
//
// Cite public identifiers instead: spec case and requirement ids (`APCC-TC-046`,
// `CPHM-FR-008`) or this repository's own issue and PR numbers. The FR-020
// failure-output contract names owning slices by title for the same reason (see
// e2e/component-plugins/_support/step-runner.ts).
//
// The disallowed names are stored only as SHA-256 digests, so this file does not
// publish what it guards against. Each `roubo-<word>` token in a file is
// lowercased, hashed, and compared. Every tracked file is scanned, not only
// source roots, because a workflow, fixture, or spec JSON leaks just as well as
// a comment. Binary files are skipped. There is no allowlist.
//
// Run with: npm run lint:repo-refs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** SHA-256 digests of the lowercased repository names that must not appear. */
export const DISALLOWED_SHA256 = new Set([
  "ad866df05e1fb8fd227108a0b9bbfcbd34c35429c10c203fb5c13f1358fe9777",
]);

const TOKEN = /roubo-[a-z0-9]+/gi;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isDisallowed(line, digests) {
  return (line.match(TOKEN) ?? []).some((t) => digests.has(sha256(t.toLowerCase())));
}

/**
 * Return one finding per line of `contents` that names a disallowed repository,
 * as `{ key: "path:line", text }`. Binary contents (a NUL byte) yield none.
 */
export function findDisallowedRefs(path, contents, digests = DISALLOWED_SHA256) {
  if (contents.includes("\0")) return [];
  const findings = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (isDisallowed(lines[i], digests)) {
      findings.push({ key: `${path}:${i + 1}`, text: lines[i].trim() });
    }
  }
  return findings;
}

/** Scan every file git tracks under `cwd`. */
export function scanTrackedFiles(cwd, digests = DISALLOWED_SHA256) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(join(cwd, file), "utf8");
    } catch {
      // A tracked path deleted in the working tree, or a submodule directory.
      continue;
    }
    findings.push(...findDisallowedRefs(file, contents, digests));
  }
  return findings;
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const findings = scanTrackedFiles(process.cwd());

  if (findings.length > 0) {
    console.error(
      `Found ${findings.length} reference(s) to a repository this project must not name.\n` +
        "Cite a public identifier instead: a spec case or requirement id (APCC-TC-046, CPHM-FR-008) or this " +
        "repository's own issue or PR number. Use a neutral fixture id (demo) in tests.\n",
    );
    for (const f of findings) console.error(`  ${f.key}: ${f.text}`);
    process.exit(1);
  }

  console.log("No disallowed repository references found.");
}
