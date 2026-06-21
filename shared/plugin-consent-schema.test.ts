import { describe, it, expect } from "vitest";
import {
  ConsentRecordSchema,
  PluginConsentStateSchema,
  declaredCategories,
  isFullyAcknowledged,
} from "./plugin-consent-schema.js";
import type { PluginPermissions } from "./plugin-manifest-schema.js";

function perms(overrides: Partial<PluginPermissions> = {}): PluginPermissions {
  return {
    network: { hosts: [] },
    credentials: { slots: [] },
    filesystem: { paths: [] },
    processes: false,
    ...overrides,
  } as PluginPermissions;
}

describe("ConsentRecordSchema", () => {
  it("accepts a well-formed record", () => {
    const parsed = ConsentRecordSchema.safeParse({
      pluginId: "db-plugin",
      acknowledgedCategories: ["docker"],
      consentedAt: "2026-06-21T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty pluginId and unknown keys", () => {
    expect(
      ConsentRecordSchema.safeParse({ pluginId: "", acknowledgedCategories: [], consentedAt: "x" })
        .success,
    ).toBe(false);
    expect(
      ConsentRecordSchema.safeParse({
        pluginId: "p",
        acknowledgedCategories: [],
        consentedAt: "x",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("PluginConsentStateSchema", () => {
  it("round-trips a valid state", () => {
    const parsed = PluginConsentStateSchema.safeParse({
      schemaVersion: 1,
      plugins: {
        "db-plugin": {
          pluginId: "db-plugin",
          acknowledgedCategories: ["docker"],
          consentedAt: "x",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a wrong schemaVersion", () => {
    expect(PluginConsentStateSchema.safeParse({ schemaVersion: 2, plugins: {} }).success).toBe(
      false,
    );
  });
});

describe("declaredCategories", () => {
  it("returns no categories when nothing is requested", () => {
    expect(declaredCategories(perms())).toEqual([]);
  });

  it("treats empty arrays / false as not-declared", () => {
    expect(
      declaredCategories(
        perms({ network: { hosts: [] }, filesystem: { paths: [] }, processes: false }),
      ),
    ).toEqual([]);
  });

  it("enumerates every requested category in canonical order", () => {
    expect(
      declaredCategories(
        perms({
          network: { hosts: ["api.example.com"] },
          credentials: { slots: [{ slot: "token", scope: "read", description: "x" }] },
          filesystem: { paths: ["/workspace"] },
          processes: { executables: ["node"] },
          ports: { names: ["http"] },
          docker: {},
        }),
      ),
    ).toEqual(["network", "credentials", "filesystem", "processes", "ports", "docker"]);
  });
});

describe("isFullyAcknowledged", () => {
  it("is true when all declared categories are acknowledged", () => {
    const p = perms({ network: { hosts: ["h"] }, docker: {} });
    expect(isFullyAcknowledged(p, ["network", "docker"])).toBe(true);
  });

  it("is false when a declared category is omitted", () => {
    const p = perms({ network: { hosts: ["h"] }, docker: {} });
    expect(isFullyAcknowledged(p, ["network"])).toBe(false);
  });

  it("tolerates extra acknowledged categories", () => {
    const p = perms({ network: { hosts: ["h"] } });
    expect(isFullyAcknowledged(p, ["network", "docker"])).toBe(true);
  });

  it("is vacuously true when nothing is declared", () => {
    expect(isFullyAcknowledged(perms(), [])).toBe(true);
  });
});
