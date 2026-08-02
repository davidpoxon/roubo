import { describe, it, expect } from "vitest";
import { parseManifest } from "./plugin-manifest.js";

describe("parseManifest", () => {
  it("returns ok for a valid manifest", () => {
    const yaml = `id: my-plugin
name: My Plugin
version: 1.0.0
description: A plugin
kind: integration
roubo: ^1.0.0
entry: ./dist/index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;
    const result = parseManifest(yaml, "roubo-plugin.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("my-plugin");
      expect(result.manifest.entry).toBe("./dist/index.js");
    }
  });

  it("returns invalid-yaml for unparseable YAML", () => {
    const result = parseManifest("id: foo\n  bad: : :", "broken.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-yaml");
    }
  });

  it("returns invalid-yaml for empty input", () => {
    const result = parseManifest("", "empty.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-yaml");
    }
  });

  it("returns schema error with field path for missing entry", () => {
    const yaml = `id: my-plugin
name: My Plugin
version: 1.0.0
description: A plugin
kind: integration
roubo: ^1.0.0
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;
    const result = parseManifest(yaml, "missing-entry.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.path).toBe("entry");
    }
  });

  it("rejects an invalid kebab-case id", () => {
    const yaml = `id: BadId
name: My Plugin
version: 1.0.0
description: A plugin
kind: integration
roubo: ^1.0.0
entry: ./index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;
    const result = parseManifest(yaml, "bad-id.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.path).toBe("id");
    }
  });
});

describe("parseManifest surfaces the declared roubo range on a schema failure (issue #719)", () => {
  function manifestWithUnknownKey(roubo: string): string {
    return `id: my-plugin
name: My Plugin
version: 1.0.0
description: A plugin
kind: integration
roubo: ${roubo}
entry: ./index.js
somethingThisHostDoesNotKnow:
  - /opt/thing
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;
  }

  it("returns the raw roubo range alongside the unrecognized-key schema error", () => {
    const result = parseManifest(manifestWithUnknownKey("^9.0.0"), "future.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.declaredRoubo).toBe("^9.0.0");
    }
  });

  it("returns the raw roubo range even when the host is in range", () => {
    // The comparison is the server's job; parseManifest only reports what was declared.
    const result = parseManifest(manifestWithUnknownKey("^1.0.0"), "in-range.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.declaredRoubo).toBe("^1.0.0");
    }
  });

  it("omits the range when the YAML never parsed", () => {
    const result = parseManifest("id: foo\n  bad: : :", "broken.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-yaml");
      expect(result.error.declaredRoubo).toBeUndefined();
    }
  });

  it("omits the range when the manifest declares no roubo field", () => {
    const yaml = `id: my-plugin
name: My Plugin
version: 1.0.0
description: A plugin
kind: integration
entry: ./index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;
    const result = parseManifest(yaml, "no-roubo.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.declaredRoubo).toBeUndefined();
    }
  });

  it("omits the range when roubo is not a non-empty string", () => {
    const yaml = `id: my-plugin
name: My Plugin
version: 1.0.0
description: A plugin
kind: integration
roubo:
  - ^1.0.0
entry: ./index.js
permissions:
  network:
    hosts: []
  credentials:
    slots: []
  filesystem:
    paths: []
  processes: false
`;
    const result = parseManifest(yaml, "list-roubo.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.declaredRoubo).toBeUndefined();
    }
  });
});
