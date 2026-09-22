import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "sdk-registry-wait.sh");
const VERSION = "0.7.0";

let binDir: string;

/**
 * Put a stub `npm` first on PATH. `npm view <pkg>@<v> version` answers from
 * `misses`: a package listed there prints nothing for its first N calls (a
 * propagation lag), and a package mapped to Infinity never resolves. `mode`
 * picks how a miss looks: `e404` mirrors npm 11 (exit 1 with an E404 on
 * stderr), `empty` mirrors older npm (exit 0 with empty stdout).
 */
function stubNpm(
  misses: Record<string, number>,
  mode: "e404" | "empty" = "e404",
  warnOnHit = false,
): void {
  const cases = Object.entries(misses)
    .map(([pkg, n]) => {
      const limit = Number.isFinite(n) ? String(n) : "999999";
      return `  "${pkg}@"*) limit=${limit} ;;`;
    })
    .join("\n");
  const miss =
    mode === "e404"
      ? `echo "npm error code E404" >&2; echo "npm error 404 No match found for version \${spec##*@}" >&2; exit 1`
      : "exit 0";
  const script = `#!/usr/bin/env bash
[[ "$1" == "view" ]] || { echo "unexpected npm call: $*" >&2; exit 2; }
spec="$2"
limit=0
case "$spec" in
${cases}
esac
counter="${binDir}/count-$(echo "$spec" | tr '/@' '__')"
n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$counter"
if (( n <= limit )); then ${miss}; fi
${warnOnHit ? 'echo "npm warn config some-key is deprecated" >&2' : ""}
echo "\${spec##*@}"
`;
  const npm = join(binDir, "npm");
  writeFileSync(npm, script);
  chmodSync(npm, 0o755);
}

function runWait(env: Record<string, string>, ...pkgs: string[]) {
  const started = Date.now();
  const result = spawnSync("bash", [SCRIPT, VERSION, ...pkgs], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
  });
  return { ...result, elapsedMs: Date.now() - started, output: result.stdout + result.stderr };
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "sdk-registry-wait-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe("sdk-registry-wait.sh", () => {
  it("resolves at once when the version is already on the registry", () => {
    stubNpm({});
    const run = runWait({}, "@roubo/plugin-sdk", "@roubo/shared");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`@roubo/plugin-sdk@${VERSION} resolvable after 0s`);
    expect(run.stdout).toContain(`@roubo/shared@${VERSION} resolvable after 0s`);
  });

  it("keeps polling through a propagation lag instead of giving up", () => {
    stubNpm({ "@roubo/plugin-sdk": 2 });
    const run = runWait(
      { SDK_SMOKE_REGISTRY_POLL_S: "1", SDK_SMOKE_REGISTRY_TIMEOUT_S: "30" },
      "@roubo/plugin-sdk",
      "@roubo/shared",
    );
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(
      /@roubo\/plugin-sdk@0\.7\.0 not yet on the registry \(propagation lag\); waited \d+s, next check in 1s/,
    );
    expect(run.stdout).toMatch(/@roubo\/plugin-sdk@0\.7\.0 resolvable after [1-9]\d*s/);
  });

  it("treats an exit-0 empty answer as not yet resolvable", () => {
    stubNpm({ "@roubo/plugin-sdk": 1 }, "empty");
    const run = runWait(
      { SDK_SMOKE_REGISTRY_POLL_S: "1", SDK_SMOKE_REGISTRY_TIMEOUT_S: "30" },
      "@roubo/plugin-sdk",
    );
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("not yet on the registry");
  });

  it("ignores npm warnings on stderr when the version resolves", () => {
    stubNpm({}, "e404", true);
    const run = runWait({ SDK_SMOKE_REGISTRY_TIMEOUT_S: "2" }, "@roubo/plugin-sdk");
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain(`@roubo/plugin-sdk@${VERSION} resolvable after 0s`);
  });

  it("fails within the ceiling, naming the package and how long it waited", () => {
    stubNpm({ "@roubo/plugin-sdk": Infinity });
    const run = runWait(
      { SDK_SMOKE_REGISTRY_POLL_S: "1", SDK_SMOKE_REGISTRY_TIMEOUT_S: "2" },
      "@roubo/plugin-sdk",
    );
    expect(run.status).not.toBe(0);
    expect(run.elapsedMs).toBeLessThan(10_000);
    expect(run.output).toMatch(
      /::error::@roubo\/plugin-sdk@0\.7\.0 did not become resolvable from the registry after waiting \d+s \(limit 2s\); registry propagation lag or a publish that never landed/,
    );
    // The last npm answer is surfaced so the log alone explains the miss.
    expect(run.output).toContain("E404");
  });

  it("checks every package, failing on the one that never lands", () => {
    stubNpm({ "@roubo/shared": Infinity });
    const run = runWait(
      { SDK_SMOKE_REGISTRY_POLL_S: "1", SDK_SMOKE_REGISTRY_TIMEOUT_S: "2" },
      "@roubo/plugin-sdk",
      "@roubo/shared",
    );
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(`@roubo/plugin-sdk@${VERSION} resolvable after`);
    expect(run.output).toMatch(/::error::@roubo\/shared@0\.7\.0 did not become resolvable/);
  });

  it("rejects a call with no packages", () => {
    stubNpm({});
    const run = runWait({});
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("usage:");
  });

  it("runs before the smoke install, for both published packages", () => {
    const smoke = readFileSync(join(import.meta.dirname, "sdk-smoke.sh"), "utf8");
    const wait = smoke.indexOf(
      '"${REPO_ROOT}/scripts/sdk-registry-wait.sh" "${VERSION}" @roubo/plugin-sdk @roubo/shared',
    );
    const install = smoke.search(/^install_with_retry$/m);
    expect(wait).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(wait);
  });
});
