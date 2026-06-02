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

  it("serializes with the canonical formatting (double-quoted string values, plain keys)", () => {
    const configPath = writeRouboConfig(tmpDir, baseConfig());
    const raw = fs.readFileSync(configPath, "utf-8");

    // Keys stay plain (unquoted), string values are double-quoted.
    expect(raw).toContain('plugin: "ghe"');
    expect(raw).toContain('instance: "https://ghe.megaleo.com"');
    expect(raw).not.toContain("'ghe'");
  });

  it("rejects an empty repoPath via the resolveWithin guard rather than touching disk", () => {
    // A malformed (empty) registry repoPath must surface as the shared
    // sanitizer's UnsafePathError, not silently resolve to the process CWD.
    expect(() => writeRouboConfig("", baseConfig())).toThrow(UnsafePathError);
  });
});
