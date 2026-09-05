#!/usr/bin/env node
// DependencyPinGuard. This repo pins every third-party dependency to an exact
// version, with no `^` or `~` ranges. Until now nothing enforced that, and the
// gap was not theoretical: Dependabot bumps write the new version into the
// workspace's `package.json` as an exact pin but record it in
// `package-lock.json` with a caret. Four such drifts (`electron`,
// `express-rate-limit`, `@codemirror/lang-markdown`, `@codemirror/view`)
// merged green before anyone noticed, because every gate in `pr-check.yml`
// runs `npm ci`, and `npm ci` accepts a lock whose recorded range merely
// SATISFIES the manifest rather than matching it.
//
// The drift also hides itself. A plain `npm install` (which the documented
// bench setup runs) silently rewrites those carets back to exact, so the
// working tree looks clean locally while the committed lock is still drifted.
// A guard that reads the two files and compares them is the only thing that
// sees it.
//
// Two rules:
//
//   1. Unpinned spec. A dependency spec in any first-party `package.json`
//      (root or workspace) that is not an exact `x.y.z`. This is the "no `^`
//      ranges" rule in CLAUDE.md, enforced at its source.
//
//   2. Lock drift. The lockfile's record of a first-party spec disagrees with
//      the `package.json` it mirrors, in either direction: a differing spec, a
//      dependency the lock omits, or one the lock carries that the manifest
//      dropped. This is the Dependabot defect above.
//
// Both rules skip the repo's OWN workspace packages (`@roubo/shared`,
// `@roubo/plugin-sdk`). Those are linked, not resolved from the registry, so
// they are declared as `*` or `file:./shared` by design and can carry no
// meaningful version pin. The exempt set is derived by reading each
// workspace's `name`, so it tracks the workspaces list and never needs
// hand-maintaining.
//
// Reading the two committed JSON files is the whole check, so this guard needs
// no install and no network. It rides in the existing `lint` job rather than
// paying for a job of its own.
//
// Run with: npm run lint:dep-pins

import { readFileSync } from "node:fs";

const DEP_KINDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// An exact version: `1.2.3`, or a prerelease such as `1.2.3-rc.1`. Anything
// else (`^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.x`, `*`, a git or file URL) is a
// range or an alternate protocol, and is not an exact pin.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The lockfile key mirroring a workspace's manifest. The root manifest is
 * recorded under the empty string; a workspace under its own path.
 *
 * @param {string} workspace - repo-relative workspace path, or "" for root.
 * @returns {string}
 */
function lockKeyFor(workspace) {
  return workspace;
}

/**
 * Human-readable label for a manifest, for use in findings.
 *
 * @param {string} workspace
 * @returns {string}
 */
function manifestPathFor(workspace) {
  return workspace ? `${workspace}/package.json` : "package.json";
}

/**
 * Compare every first-party manifest against the lockfile's record of it.
 *
 * Pure over its inputs so the test can drive it with in-memory fixtures.
 *
 * @param {object} lock - parsed package-lock.json.
 * @param {Record<string, object>} manifests - workspace path (or "" for root)
 *   to that workspace's parsed package.json. Must include "".
 * @returns {{ file: string, dependency: string, kind: string, reason: string }[]}
 */
export function scanPins(lock, manifests) {
  const findings = [];

  // The repo's own workspace packages, derived from the manifests themselves.
  // These are linked rather than fetched, so no version pin applies to them.
  const ownPackages = new Set(
    Object.entries(manifests)
      .filter(([workspace]) => workspace !== "")
      .map(([, manifest]) => manifest.name)
      .filter(Boolean),
  );

  for (const [workspace, manifest] of Object.entries(manifests)) {
    const file = manifestPathFor(workspace);
    const lockEntry = lock.packages?.[lockKeyFor(workspace)];

    if (!lockEntry) {
      findings.push({
        file,
        dependency: "*",
        kind: "*",
        reason:
          "the lockfile has no record of this workspace. Run `npm install` and " +
          "commit the regenerated package-lock.json.",
      });
      continue;
    }

    for (const kind of DEP_KINDS) {
      const declared = manifest[kind] ?? {};
      const locked = lockEntry[kind] ?? {};

      for (const [dependency, spec] of Object.entries(declared)) {
        if (ownPackages.has(dependency)) continue;

        // Rule 1: the manifest itself must carry an exact pin.
        if (!EXACT_VERSION.test(spec)) {
          findings.push({
            file,
            dependency,
            kind,
            reason:
              `spec '${spec}' is not an exact version. This repo pins every ` +
              "third-party dependency exactly, with no `^` or `~` ranges.",
          });
        }

        // Rule 2: the lockfile must record that same spec verbatim.
        const lockedSpec = locked[dependency];
        if (lockedSpec === undefined) {
          findings.push({
            file,
            dependency,
            kind,
            reason:
              `declared as '${spec}' but absent from the lockfile's ${kind} for ` +
              "this workspace. Run `npm install` and commit the regenerated " +
              "package-lock.json.",
          });
        } else if (lockedSpec !== spec) {
          findings.push({
            file,
            dependency,
            kind,
            reason:
              `declared as '${spec}' but the lockfile records '${lockedSpec}'. ` +
              "A lock that merely SATISFIES the manifest still passes `npm ci`, " +
              "so this drift is invisible to every other gate. Run `npm install` " +
              "and commit the regenerated package-lock.json.",
          });
        }
      }

      // Rule 2, other direction: a dependency the lock still carries after the
      // manifest dropped it.
      for (const dependency of Object.keys(locked)) {
        if (ownPackages.has(dependency)) continue;
        if (dependency in declared) continue;
        findings.push({
          file,
          dependency,
          kind,
          reason:
            `recorded in the lockfile's ${kind} but no longer declared here. ` +
            "Run `npm install` and commit the regenerated package-lock.json.",
        });
      }
    }
  }

  // Rule 1 again, over the root `overrides` block. An override is a pin like
  // any other, and the one on `@electron/rebuild` is load-bearing: forge
  // declares `^3.7.0` against a tree pinned to 4.x, and CLAUDE.md requires the
  // root override and `electron/package.json` to carry the same exact version.
  // A range here would let that pair drift apart silently. The lockfile does
  // not mirror `overrides`, so only the exact-pin rule applies.
  walkOverrides(manifests[""]?.overrides ?? {}, [], (path, dependency, spec) => {
    if (EXACT_VERSION.test(spec)) return;
    findings.push({
      file: "package.json",
      dependency,
      kind: path.length > 0 ? `overrides.${path.join(".")}` : "overrides",
      reason:
        `override '${spec}' is not an exact version. An override is a pin like ` +
        "any other, and a range here defeats the point of overriding.",
    });
  });

  return findings;
}

/**
 * Visit every leaf spec in an `overrides` block. npm allows an override to be
 * either a version string or a nested object scoping further overrides, so
 * recurse rather than assuming the flat shape the repo happens to use today.
 *
 * @param {object} overrides
 * @param {string[]} path - enclosing override names, outermost first.
 * @param {(path: string[], dependency: string, spec: string) => void} visit
 */
function walkOverrides(overrides, path, visit) {
  for (const [dependency, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      visit(path, dependency, value);
    } else if (value && typeof value === "object") {
      walkOverrides(value, [...path, dependency], visit);
    }
  }
}

/**
 * Read the root manifest, every workspace manifest, and the lockfile.
 *
 * @param {(f: string) => string} readFn
 * @returns {{ lock: object, manifests: Record<string, object> }}
 */
export function loadTree(readFn) {
  const root = JSON.parse(readFn("package.json"));
  const manifests = { "": root };
  for (const workspace of root.workspaces ?? []) {
    manifests[workspace] = JSON.parse(readFn(`${workspace}/package.json`));
  }
  return { lock: JSON.parse(readFn("package-lock.json")), manifests };
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { lock, manifests } = loadTree((f) => readFileSync(f, "utf8"));
  const findings = scanPins(lock, manifests);

  if (findings.length > 0) {
    console.error(
      `Found ${findings.length} dependency-pin violation(s). Every third-party ` +
        "dependency is pinned to an exact version, and package-lock.json must " +
        "record each spec verbatim.\n",
    );
    for (const v of findings) {
      console.error(`  ${v.file}: ${v.kind}.${v.dependency}`);
      console.error(`    -> ${v.reason}`);
    }
    process.exit(1);
  }

  console.log("No dependency-pin violations found (every spec is exact and matches the lockfile).");
}
