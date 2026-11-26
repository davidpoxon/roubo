import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDisposablePackagedE2EState } from "./e2e-state-guard.js";

const PACKAGED_ENV = { ROUBO_E2E: "1", ROUBO_E2E_PACKAGED: "1", ROUBO_PRODUCTION: "1" };

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-e2e-state-guard-")));
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isDisposablePackagedE2EState (HR-TC-053 packaged run)", () => {
  it("allows the packaged run on a throwaway home under the temp dir", () => {
    expect(
      isDisposablePackagedE2EState({
        env: PACKAGED_ENV,
        rouboDir: path.join(home, ".roubo"),
        homeDir: home,
        tmpDir: tmp,
      }),
    ).toBe(true);
  });

  it("refuses a run that does not ask for the packaged mode by name", () => {
    const env: NodeJS.ProcessEnv = { ...PACKAGED_ENV };
    delete env.ROUBO_E2E_PACKAGED;
    expect(
      isDisposablePackagedE2EState({
        env,
        rouboDir: path.join(home, ".roubo"),
        homeDir: home,
        tmpDir: tmp,
      }),
    ).toBe(false);
  });

  it("refuses a home that is not under the temp dir", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-other-")));
    try {
      expect(
        isDisposablePackagedE2EState({
          env: PACKAGED_ENV,
          rouboDir: path.join(home, ".roubo"),
          homeDir: home,
          tmpDir: elsewhere,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a state dir that is not <home>/.roubo", () => {
    expect(
      isDisposablePackagedE2EState({
        env: PACKAGED_ENV,
        rouboDir: path.join(home, ".roubo-dev", "roubo"),
        homeDir: home,
        tmpDir: tmp,
      }),
    ).toBe(false);
  });

  it("refuses without ROUBO_E2E or ROUBO_PRODUCTION", () => {
    for (const drop of ["ROUBO_E2E", "ROUBO_PRODUCTION"] as const) {
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(PACKAGED_ENV).filter(([name]) => name !== drop),
      );
      expect(
        isDisposablePackagedE2EState({
          env,
          rouboDir: path.join(home, ".roubo"),
          homeDir: home,
          tmpDir: tmp,
        }),
      ).toBe(false);
    }
  });
});
