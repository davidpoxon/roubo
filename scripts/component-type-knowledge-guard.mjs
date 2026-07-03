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
//
//   2. Docker/compose field branch. Member access on a docker-only descriptor
//      field (composeFile, initService, portEnvVar, composeUp, composeDown,
//      composeRunInit, composeStop) anywhere in core, EXCEPT the modules that
//      own container lifecycle: the broker, the docker facade, the lifecycle
//      engine, and the descriptor schema. Everywhere else, reading a docker
//      field means core has regrown container knowledge.
//
//      bench-manager is a narrower case (issue #400, CP-TC-042): post-#612 it
//      reads only the PLUGIN's cached `descriptor` (its typed output, not a
//      config docker-field) to drive teardown / reconcile, and it calls the
//      docker facade methods for that teardown. A blanket file allowlist there
//      let an injected config docker-field read (e.g. componentConfig.docker
//      .composeFile) slip through undetected. So bench-manager is receiver-
//      scoped instead: a docker-field READ is allowed only when its receiver is
//      `descriptor`; facade METHOD calls (dockerService.composeStop(...)) are
//      allowed; any other receiver (a config object) is still a violation.
//
// Both rules match against the comment-stripped source so prose that documents
// the forbidden patterns (e.g. "no `=== \"database\"` dispatch", or a
// `.composeFile` mention in a comment) is not itself a violation. Stripping
// comments can never hide a real dispatch or field access, so the guard stays
// sound.
//
// Run with: npm run lint:component-guard

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOTS = ["server", "shared"];

// Modules that legitimately own container-lifecycle knowledge, so a docker
// field reference there is correct, not a regression. The broker is the
// privileged choke-point, docker is the compose facade, the lifecycle engine
// executes descriptors, and the schema defines the descriptor union.
const DOCKER_FIELD_ALLOWLIST = new Set([
  "server/services/component-broker.ts",
  "server/services/docker.ts",
  "server/services/lifecycle-engine.ts",
  "shared/provision-descriptor-schema.ts",
]);

// Files where a docker-field READ is allowed only on the `descriptor` receiver
// (the plugin's typed output), not wholesale (issue #400, CP-TC-042). Rule 2
// runs against these files but flags a docker-field read whose receiver is any
// object other than `descriptor`; facade method calls are left to the method
// carve-out below. This is the receiver-scoped middle ground between "fully
// allowlisted" and "fully checked" the blanket bench-manager allowlist lacked.
const DOCKER_FIELD_DESCRIPTOR_RECEIVER = new Set(["server/services/bench-manager.ts"]);

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

// Rule 2 (receiver-scoped variant): a docker-field READ that is NOT a method
// call, capturing the receiver identifier so a `descriptor`-typed read can be
// distinguished from a config-object read. The negative lookahead `(?!\s*\()`
// excludes facade method calls (dockerService.composeStop(...)), leaving only
// field reads; capture group 1 is the receiver token (e.g. `descriptor`,
// `componentConfig`, `docker`). Optional chaining (`descriptor?.composeFile`) is
// tolerated. Global so a line with several reads is fully scanned.
const DOCKER_FIELD_READ =
  /([\w$]+)\??\.(composeFile|initService|portEnvVar|composeUp|composeDown|composeRunInit|composeStop)\b(?!\s*\()/g;

// The one receiver a docker-field read may name in a receiver-scoped file: the
// plugin's typed ProvisionDescriptor output (not a config docker-field).
const DOCKER_FIELD_ALLOWED_RECEIVER = "descriptor";

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
    // Both rules match against the comment-stripped source so prose that
    // documents the forbidden patterns (a `=== "database"` or `.composeFile`
    // mention in a comment) is never itself a violation. rawLines is kept only
    // for the reported `text`. Stripping comments can never hide a real
    // dispatch or field access (those are code, not comments), so the guard
    // stays sound for both rules.
    const codeLines = stripComments(contents).split("\n");

    // Rule 1: component-type literal dispatch.
    if (!TYPE_LITERAL_ALLOWLIST.has(file)) {
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
    if (DOCKER_FIELD_ALLOWLIST.has(file)) {
      // Fully owns container-lifecycle knowledge; rule 2 does not apply.
    } else if (DOCKER_FIELD_DESCRIPTOR_RECEIVER.has(file)) {
      // Receiver-scoped: a docker-field READ is a violation unless its receiver
      // is `descriptor` (the plugin's typed output). Facade method calls are
      // excluded by DOCKER_FIELD_READ's negative lookahead, so they never flag.
      for (let i = 0; i < codeLines.length; i++) {
        for (const match of codeLines[i].matchAll(DOCKER_FIELD_READ)) {
          const receiver = match[1];
          if (receiver === DOCKER_FIELD_ALLOWED_RECEIVER) continue;
          findings.push({
            file,
            line: i + 1,
            text: rawLines[i].trim(),
            reason:
              `core docker/compose field read on '${receiver}' (${DOCKER_FIELD_NAMES}): ` +
              `only a '${DOCKER_FIELD_ALLOWED_RECEIVER}'-typed read is allowed here; a config ` +
              "docker-field read means core has regrown container knowledge (CP-NFR-006).",
          });
        }
      }
    } else {
      for (let i = 0; i < codeLines.length; i++) {
        if (DOCKER_FIELD.test(codeLines[i])) {
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
