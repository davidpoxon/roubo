import { describe, expect, it } from "vitest";
import type {
  GlobalPluginIntegrationState,
  IntegrationConfig,
  PluginManifest,
  PluginRecord,
  PluginStatus,
} from "@roubo/shared";
import { derivePluginConnectionState, primaryActionLabelFor } from "./derivePluginConnectionState";

function manifest(): PluginManifest {
  return {
    id: "github-com",
    name: "GitHub.com",
    version: "1.0.0",
    description: "GitHub.com integration",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "dist/index.js",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
  };
}

function plugin(status: PluginStatus = "enabled"): PluginRecord {
  return {
    id: "github-com",
    manifest: manifest(),
    manifestPath: "/p/github-com/roubo-plugin.yaml",
    pluginDir: "/p/github-com",
    source: "bundled",
    status,
    lastError: null,
    restartHistory: [],
    pid: 1,
  };
}

function integration(effective: IntegrationConfig): GlobalPluginIntegrationState {
  return {
    effective,
    plugin: {
      id: "github-com",
      installed: true,
      status: "enabled",
      manifest: { name: "GitHub.com" },
    },
  };
}

describe("derivePluginConnectionState", () => {
  it('returns "disabled" for a disabled plugin regardless of config', () => {
    expect(derivePluginConnectionState(plugin("disabled"))).toBe("disabled");
    expect(
      derivePluginConnectionState(
        plugin("disabled"),
        integration({ capturedUserId: { externalId: "1", displayName: "u" } }),
      ),
    ).toBe("disabled");
  });

  it('returns "errored" for the errored lifecycle status', () => {
    expect(derivePluginConnectionState(plugin("errored"))).toBe("errored");
  });

  it('returns "errored" for the incompatible lifecycle status', () => {
    expect(derivePluginConnectionState(plugin("incompatible"))).toBe("errored");
  });

  it('returns "errored" for the invalid lifecycle status', () => {
    expect(derivePluginConnectionState(plugin("invalid"))).toBe("errored");
  });

  it('returns "disconnected" for an enabled plugin with no integration data yet', () => {
    expect(derivePluginConnectionState(plugin("enabled"))).toBe("disconnected");
  });

  it('returns "disconnected" for an enabled plugin with empty effective config', () => {
    expect(derivePluginConnectionState(plugin("enabled"), integration({}))).toBe("disconnected");
  });

  it('returns "connected" when capturedUserId is present', () => {
    expect(
      derivePluginConnectionState(
        plugin("enabled"),
        integration({ capturedUserId: { externalId: "42", displayName: "Octocat" } }),
      ),
    ).toBe("connected");
  });

  it('returns "connected" for instance-based plugins once an instance URL is saved', () => {
    expect(
      derivePluginConnectionState(
        plugin("enabled"),
        integration({ instance: "https://ghe.example" }),
      ),
    ).toBe("connected");
  });

  it("ignores an empty-string instance", () => {
    expect(derivePluginConnectionState(plugin("enabled"), integration({ instance: "" }))).toBe(
      "disconnected",
    );
  });
});

describe("primaryActionLabelFor", () => {
  it.each([
    ["disabled", "Connect"],
    ["disconnected", "Connect"],
    ["connected", "Configure"],
    ["errored", "Configure"],
    ["auth-problem", "Sign in again"],
  ] as const)("%s -> %s", (state, label) => {
    expect(primaryActionLabelFor(state)).toBe(label);
  });
});
