#!/usr/bin/env node
// ComponentTypeKnowledgeGuard (issue #617, CP-NFR-006). After the component
// plugin refactor (#612) removed type dispatch from core, this guard makes the
// zero-core-knowledge invariant permanent: it fails the build if a
// component-type literal or a core docker/compose field branch reappears in
// core (server/ + shared/), outside the bundled plugins and the small set of
// modules that legitimately own that knowledge.
//
// Two rule sets:
//
//   1. Component-type literal. A dispatch on the component-type discriminator:
//      an equality (=== / ==) against 'database' or 'process', or a
//      `case 'database':` / `case 'process':`. These are the dispatch sites the
//      refactor removed; reintroducing one is the regression NFR-006 forbids.
//      Comments are stripped before scanning so prose that documents the rule
//      (e.g. "no `=== \"database\"` dispatch") is not itself a violation.
//
//   2. Docker/compose field branch. Member access on a docker-only descriptor
//      field (composeFile, initService, portEnvVar, composeUp, composeDown,
//      composeRunInit, composeStop) anywhere in core, EXCEPT the modules that
//      own container lifecycle: the broker, the docker facade, the lifecycle
//      engine, the descriptor schema, and bench-manager (which, post-#612,
//      reads the PLUGIN's cached descriptor, not a config docker-field, to
//      drive teardown / reconcile). Everywhere else, reading a docker field
//      means core has regrown container knowledge.
//
// Run with: npm run lint:component-guard

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOTS = ["server", "shared"];

// Modules that legitimately own container-lifecycle knowledge, so a docker
// field reference there is correct, not a regression. The broker is the
// privileged choke-point, docker is the compose facade, the lifecycle engine
// executes descriptors, the schema defines the descriptor union, and
// bench-manager reads the plugin's cached descriptor (its typed output, not a
// config docker-field) to down compose projects on teardown / reconcile.
const DOCKER_FIELD_ALLOWLIST = new Set([
  "server/services/component-broker.ts",
  "server/services/docker.ts",
  "server/services/lifecycle-engine.ts",
  "server/services/bench-manager.ts",
  "shared/provision-descriptor-schema.ts",
]);

// The lifecycle engine switches on the ProvisionDescriptor's own `kind` tag
// (docker | process | oneshot), which is the engine's domain, not a core
// component-type dispatch. That descriptor-kind switch is the only legitimate
// `case 'process':` in core, so the engine is allowlisted for rule 1.
const TYPE_LITERAL_ALLOWLIST = new Set(["server/services/lifecycle-engine.ts"]);

// Rule 1: an equality or case dispatch on the 'database' / 'process'
// component-type literal.
const TYPE_LITERAL =
  /(===?\s*|case\s+)['"](database|process)['"]|['"](database|process)['"]\s*===?/;

// Rule 2: member access on a docker-only descriptor field.
const DOCKER_FIELD =
  /\.(composeFile|initService|portEnvVar|composeUp|composeDown|composeRunInit|composeStop)\b/;

const DOCKER_FIELD_NAMES =
  "composeFile, initService, portEnvVar, composeUp, composeDown, composeRunInit, composeStop";

// Strip // line comments and /* */ block comments so prose documenting the
// rule does not register as a violation. String-literal awareness is
// intentionally omitted: a `//` or `/*` inside a string is rare in this
// codebase and stripping it only ever removes a would-be violation from a
// string, never a real dispatch, so the guard stays sound (it cannot miss a
// genuine `=== 'database'`).
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

/**
 * Scan the given files for component-type-knowledge violations.
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

    // Rule 1: component-type literal dispatch, comments stripped.
    if (!TYPE_LITERAL_ALLOWLIST.has(file)) {
      const codeLines = stripComments(contents).split("\n");
      for (let i = 0; i < codeLines.length; i++) {
        if (TYPE_LITERAL.test(codeLines[i])) {
          findings.push({
            file,
            line: i + 1,
            text: rawLines[i].trim(),
            reason:
              "component-type literal dispatch (=== 'database' / 'process' or case): " +
              "core must not branch on the component type (CP-NFR-006).",
          });
        }
      }
    }

    // Rule 2: docker/compose field branch outside the owning modules.
    if (!DOCKER_FIELD_ALLOWLIST.has(file)) {
      for (let i = 0; i < rawLines.length; i++) {
        if (DOCKER_FIELD.test(rawLines[i])) {
          findings.push({
            file,
            line: i + 1,
            text: rawLines[i].trim(),
            reason:
              `core docker/compose field branch (${DOCKER_FIELD_NAMES}): ` +
              "container access must go through the broker / lifecycle engine (CP-NFR-006).",
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
  // tree (the one place docker-field knowledge belongs).
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
      `Found ${findings.length} component-type-knowledge violation(s). ` +
        "CP-NFR-006 requires core (server/ + shared/) to hold zero component-type " +
        "literals and zero docker/compose field branches outside the bundled " +
        "plugins and the container-lifecycle modules.\n",
    );
    for (const v of findings) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
      console.error(`    -> ${v.reason}`);
    }
    process.exit(1);
  }

  console.log("No component-type-knowledge violations found (zero core type/docker knowledge).");
}
