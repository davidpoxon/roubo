import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginContract } from "../plugin.js";
import { installHostHarness, StubResponse, type HostHarness } from "./helpers/host-stub.js";
import { _resetCacheForTests } from "../state-store.js";

describe("end-to-end (TC-048 Test connection round-trip)", () => {
  let harness: HostHarness;

  beforeEach(() => {
    _resetCacheForTests();
    harness = installHostHarness(createPluginContract());
    harness.credentials.set("pat", "test-token");
  });
  afterEach(() => {
    harness.dispose();
    _resetCacheForTests();
  });

  it("validateConfig + getCurrentUser succeed against a healthy /myself", async () => {
    harness.fetchStub.on("/rest/api/2/myself", () => ({
      accountId: "alice",
      displayName: "Anna Smith",
    }));

    const validation = await harness.hostConnection.sendRequest<{ ok: boolean }>("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });
    expect(validation).toEqual({ ok: true });

    const me = await harness.hostConnection.sendRequest<{
      externalId: string;
      displayName: string;
    }>("getCurrentUser", {});
    expect(me).toEqual({ externalId: "alice", displayName: "Anna Smith" });
  });

  it("validateConfig returns a structured error for an invalid instance URL", async () => {
    const result = await harness.hostConnection.sendRequest<{
      ok: boolean;
      errors?: Array<{ field?: string; message: string }>;
    }>("validateConfig", { config: { instance: "" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatchObject({ field: "instance" });
  });

  it("validateConfig propagates a 401 from /myself", async () => {
    harness.credentials.set("pat", "bad");
    harness.fetchStub.on("/rest/api/2/myself", () => new StubResponse(401, ""));
    const result = await harness.hostConnection.sendRequest<{
      ok: boolean;
      errors?: Array<{ message: string }>;
    }>("validateConfig", { config: { instance: "https://jira.acme.example" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].message).toContain("401");
  });

  it("listIssues sends JQL with 'updated >=' and persists the watermark (TC-030)", async () => {
    // Bootstrap the in-process config cache via validateConfig.
    harness.fetchStub.on("/rest/api/2/myself", () => ({ displayName: "Anna" }));
    await harness.hostConnection.sendRequest("validateConfig", {
      config: { instance: "https://jira.acme.example", pat: "test-token" },
    });

    // Seed an existing watermark so the next poll filters incrementally.
    harness.credentials.set("state", JSON.stringify({ "filter:456": "2026-04-01T00:00:00Z" }));

    let capturedJql = "";
    harness.fetchStub.on("/rest/api/2/search", (init) => {
      const body = JSON.parse(init.body ?? "{}");
      capturedJql = body.jql ?? "";
      return {
        issues: [
          {
            key: "PROJ-1",
            fields: { summary: "later", status: { name: "Open" }, updated: "2026-04-05T00:00:00Z" },
          },
        ],
        total: 1,
      };
    });

    const result = await harness.hostConnection.sendRequest<{
      items: Array<{ externalId: string }>;
      nextCursor: string | null;
    }>("listIssues", {
      cursor: null,
      pageSize: 50,
      config: { sources: { filters: ["456"] } },
    });

    expect(capturedJql).toContain('updated >= "2026-04-01T00:00:00Z"');
    expect(result.items.map((i) => i.externalId)).toEqual(["PROJ-1"]);
    expect(harness.credentials.get("state")).toContain("2026-04-05T00:00:00Z");
  });
});
