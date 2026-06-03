import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as YAML from "yaml";
import type { RouboConfig } from "@roubo/shared";
import { writeRouboConfig } from "./write-roubo-config.js";
import { UnsafePathError } from "../lib/safe-path.js";

let tmpDir: string;

function baseConfig(): RouboConfig {
  return {
    project: { name: "demo", displayName: "Demo", repo: "acme/demo" },
    layout: { type: "single-repo" },
    components: { server: { type: "process", command: "npm start" } },
    ports: { server: { base: 3000 } },
    benches: { max: 5 },
    integration: { plugin: "ghe", instance: "https://ghe.megaleo.com" },
  } as unknown as RouboConfig;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-roubo-config-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeRouboConfig", () => {
  it("writes .roubo/roubo.yaml under the repo root and returns the resolved path", () => {
    const configPath = writeRouboConfig(tmpDir, baseConfig());

    expect(configPath).toBe(path.join(tmpDir, ".roubo", "roubo.yaml"));
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = YAML.parse(fs.readFileSync(configPath, "utf-8")) as RouboConfig;
    expect(parsed.integration?.plugin).toBe("ghe");
    expect(parsed.integration?.instance).toBe("https://ghe.megaleo.com");
  });

  it("creates the .roubo directory when it does not exist yet", () => {
    expect(fs.existsSync(path.join(tmpDir, ".roubo"))).toBe(false);

    writeRouboConfig(tmpDir, baseConfig());

    expect(fs.existsSync(path.join(tmpDir, ".roubo"))).toBe(true);
  });

  it("serializes with the yaml library defaults: minimal quoting, no invented quote rule", () => {
    const configPath = writeRouboConfig(tmpDir, baseConfig());
    const raw = fs.readFileSync(configPath, "utf-8");

    // Library defaults emit plain scalars when a value does not need quoting,
    // rather than the old forced-double-quote profile that rewrote configs on
    // every save. A plain URL contains no space after its colon, so it stays
    // unquoted too.
    expect(raw).toContain("plugin: ghe");
    expect(raw).toContain("instance: https://ghe.megaleo.com");
    expect(raw).not.toContain('plugin: "ghe"');
    expect(raw).not.toContain("plugin: 'ghe'");
  });

  it("quotes a value only when leaving it plain would change its parsed type", () => {
    const configPath = writeRouboConfig(tmpDir, {
      ...baseConfig(),
      project: { name: "demo", displayName: "123", repo: "acme/demo" },
    } as unknown as RouboConfig);
    const raw = fs.readFileSync(configPath, "utf-8");

    // displayName is a string field. The string "123" would parse back as a
    // number if left plain, so the library quotes it (with double quotes when
    // it must quote) to preserve the string type across a round-trip. This is
    // the default doing minimal-but-necessary quoting, not a blanket rule:
    // `repo: acme/demo` on the same object stays plain.
    expect(raw).toContain('displayName: "123"');
    expect(raw).toContain("repo: acme/demo");
  });

  it("rejects an empty repoPath via the resolveWithin guard rather than touching disk", () => {
    // A malformed (empty) registry repoPath must surface as the shared
    // sanitizer's UnsafePathError, not silently resolve to the process CWD.
    expect(() => writeRouboConfig("", baseConfig())).toThrow(UnsafePathError);
  });
});
