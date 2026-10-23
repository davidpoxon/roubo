// The record loader's path handling for a Spec Bench: the record is read from
// `.specifications/<slug>/` inside the bench workspace (SB-FR-002, SB-FR-009).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverySpecFolder, loadBenchDeliveryRecord } from "./delivery-record-loader.js";

let tmp: string;
let workspace: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-record-loader-"));
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const focusedSpecPath = "/repo/.specifications/fixture-spec";

describe("loadBenchDeliveryRecord", () => {
  it("resolves the spec folder of the slug inside the bench workspace", () => {
    expect(deliverySpecFolder({ workspacePath: workspace, focusedSpecPath })).toBe(
      path.join(workspace, ".specifications", "fixture-spec"),
    );
  });

  it("answers DELIVERY_RECORD_MISSING when the workspace has no spec folder yet", () => {
    expect(fs.existsSync(path.join(workspace, ".specifications"))).toBe(false);
    const loaded = loadBenchDeliveryRecord({ workspacePath: workspace, focusedSpecPath });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("answers DELIVERY_RECORD_MISSING when the workspace itself does not exist yet", () => {
    const loaded = loadBenchDeliveryRecord({
      workspacePath: path.join(tmp, "not-provisioned"),
      focusedSpecPath,
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("refuses a focused spec path whose slug fails the allowlist", () => {
    const loaded = loadBenchDeliveryRecord({
      workspacePath: workspace,
      focusedSpecPath: "/repo/.specifications/Bad Slug",
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_INVALID");
  });

  it("refuses a workspace spec folder that is a symlink out of the workspace", () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(path.join(outside, "fixture-spec"), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, ".specifications"));
    const loaded = loadBenchDeliveryRecord({ workspacePath: workspace, focusedSpecPath });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_INVALID");
  });
});
