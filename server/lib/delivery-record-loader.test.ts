// The record loader's path handling for a Spec Bench: the record is read from
// `.specifications/<slug>/` inside the bench workspace (SB-FR-002, SB-FR-009),
// and copied between that folder and the checkout's spec folder (SB-FR-004).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deliverySpecFolder,
  loadBenchDeliveryRecord,
  preserveDeliveryRecord,
  seedWorkspaceDeliveryRecord,
} from "./delivery-record-loader.js";

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

describe("copying the record between the workspace and the checkout", () => {
  let checkout: string;
  let workspaceFolder: string;
  let bench: { workspacePath: string; focusedSpecPath: string };

  beforeEach(() => {
    checkout = path.join(tmp, "repo", ".specifications", "fixture-spec");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "test-results.json"), "{}\n");
    workspaceFolder = path.join(workspace, ".specifications", "fixture-spec");
    bench = { workspacePath: workspace, focusedSpecPath: checkout };
  });

  it("preserves the workspace record into the checkout, over an older copy, and keeps the rest", () => {
    fs.mkdirSync(workspaceFolder, { recursive: true });
    fs.writeFileSync(path.join(workspaceFolder, "delivery-observation.json"), '{"new":1}\n');
    fs.writeFileSync(path.join(checkout, "delivery-observation.json"), '{"old":1}\n');

    expect(preserveDeliveryRecord(bench)).toBe(true);
    expect(fs.readFileSync(path.join(checkout, "delivery-observation.json"), "utf8")).toBe(
      '{"new":1}\n',
    );
    expect(fs.readdirSync(checkout).sort()).toEqual([
      "delivery-observation.json",
      "test-results.json",
    ]);
  });

  it("preserves nothing when the workspace has no record, and leaves the checkout's copy", () => {
    fs.writeFileSync(path.join(checkout, "delivery-observation.json"), '{"old":1}\n');
    expect(preserveDeliveryRecord(bench)).toBe(false);
    expect(fs.readFileSync(path.join(checkout, "delivery-observation.json"), "utf8")).toBe(
      '{"old":1}\n',
    );
  });

  it("preserves nothing through a checkout record that is a symlink out of the spec folder", () => {
    fs.mkdirSync(workspaceFolder, { recursive: true });
    fs.writeFileSync(path.join(workspaceFolder, "delivery-observation.json"), '{"new":1}\n');
    const outside = path.join(tmp, "outside.json");
    fs.writeFileSync(outside, "untouched\n");
    fs.symlinkSync(outside, path.join(checkout, "delivery-observation.json"));

    expect(preserveDeliveryRecord(bench)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched\n");
  });

  it("seeds a workspace with no record from the checkout, creating its spec folder", () => {
    fs.writeFileSync(path.join(checkout, "delivery-observation.json"), '{"kept":1}\n');
    expect(fs.existsSync(workspaceFolder)).toBe(false);

    expect(seedWorkspaceDeliveryRecord(bench)).toBe(true);
    expect(fs.readFileSync(path.join(workspaceFolder, "delivery-observation.json"), "utf8")).toBe(
      '{"kept":1}\n',
    );
  });

  it("leaves a workspace record as it is, and seeds nothing when the checkout has none", () => {
    expect(seedWorkspaceDeliveryRecord(bench)).toBe(false);
    expect(fs.existsSync(workspaceFolder)).toBe(false);

    fs.mkdirSync(workspaceFolder, { recursive: true });
    fs.writeFileSync(path.join(workspaceFolder, "delivery-observation.json"), '{"live":1}\n');
    fs.writeFileSync(path.join(checkout, "delivery-observation.json"), '{"kept":1}\n');
    expect(seedWorkspaceDeliveryRecord(bench)).toBe(false);
    expect(fs.readFileSync(path.join(workspaceFolder, "delivery-observation.json"), "utf8")).toBe(
      '{"live":1}\n',
    );
  });
});
