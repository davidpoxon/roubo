// The trust derivation behind the shared badge (CPHMTP-FR-006 / CPHMTP-NFR-001 /
// CPHMTP-US-005, issue #563). CPHMTP-NFR-001 requires "0 UI states where a
// third-party plugin renders first-party verified styling" (CPHMTP-TC-056
// S002-O01). Every plugin surface renders ProvenanceBadge and nothing else
// decides trust, so that property reduces to this one function: if the verified
// treatment is unreachable here for a non-first-party source, it is unreachable
// everywhere. These tests pin the gate, including against a hostile catalog
// injecting `verified: true` (CPHMTP-TC-072 S001).

import { describe, it, expect } from "vitest";
import { FIRST_PARTY_SOURCE_ID, SEED_PLUGIN_IDS } from "@roubo/shared";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";
import {
  FIRST_PARTY_LABEL,
  UNKNOWN_SOURCE_ID,
  UNKNOWN_SOURCE_LABEL,
  listingProvenance,
  recordProvenance,
  trustTreatmentOf,
  type PluginProvenance,
} from "./plugin-provenance";

const ACME_SOURCE_ID = "marketplace-acme-example-1a2b3c4d";
const ACME_LABEL = "ACME workplace";

function provenance(over: Partial<PluginProvenance> = {}): PluginProvenance {
  return {
    sourceId: FIRST_PARTY_SOURCE_ID,
    sourceLabel: FIRST_PARTY_LABEL,
    curated: true,
    orphaned: false,
    ...over,
  };
}

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: "ghe",
    name: "GitHub Enterprise",
    kind: "integration",
    version: "1.0.0",
    summary: "Connect a self-hosted GitHub Enterprise instance.",
    source: { type: "git", url: "https://example.com/ghe.git" },
    provenance: "acme/plugins@ghe",
    integrity: "sha256-ghe",
    verified: false,
    installed: false,
    installedVersion: null,
    updateAvailable: false,
    declaredPermissions: null,
    lifecycle: null,
    sourceId: ACME_SOURCE_ID,
    ...over,
  };
}

function record(over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "ghe",
    manifest: null,
    manifestPath: "/p/ghe/roubo-plugin.yaml",
    pluginDir: "/p/ghe",
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: null,
    ...over,
  };
}

describe("trustTreatmentOf: the single trust gate (CPHMTP-NFR-001)", () => {
  it("gives the verified treatment only to a curated first-party entry", () => {
    expect(trustTreatmentOf(provenance())).toBe("verified");
  });

  // The hostile-catalog case (CPHMTP-TC-072 S001-O01/O02). A third-party source
  // serves an entry claiming curation; the gate requires the first-party source id
  // too, so the claim buys it nothing.
  it("ignores a curation claim from a third-party source", () => {
    expect(trustTreatmentOf(provenance({ sourceId: ACME_SOURCE_ID, curated: true }))).toBe(
      "unverified",
    );
  });

  // Fails closed: no source id the app knows about means no verification.
  it("treats an uncurated first-party entry and an unknown source as unverified", () => {
    expect(trustTreatmentOf(provenance({ curated: false }))).toBe("unverified");
    expect(trustTreatmentOf(provenance({ sourceId: "who-knows" }))).toBe("unverified");
  });

  // Orphaning is orthogonal to trust: losing the source does not verify or
  // unverify the code that is already installed (CPHMTP-FR-009).
  it("does not let orphaning change the trust treatment", () => {
    expect(trustTreatmentOf(provenance({ orphaned: true }))).toBe("verified");
    expect(trustTreatmentOf(provenance({ sourceId: ACME_SOURCE_ID, orphaned: true }))).toBe(
      "unverified",
    );
  });
});

describe("listingProvenance / recordProvenance normalisation", () => {
  it("normalises a third-party listing to unverified with its source label", () => {
    const result = listingProvenance(listing(), ACME_LABEL);
    expect(result).toEqual({
      sourceId: ACME_SOURCE_ID,
      sourceLabel: ACME_LABEL,
      curated: false,
      orphaned: false,
    });
    expect(trustTreatmentOf(result)).toBe("unverified");
  });

  // A catalog entry is never orphaned: orphaning is a property of an install
  // record whose source was removed, not of a listing you could still install.
  it("never marks a listing orphaned, whatever its source", () => {
    expect(listingProvenance(listing(), ACME_LABEL).orphaned).toBe(false);
    expect(listingProvenance(listing({ sourceId: FIRST_PARTY_SOURCE_ID }), "x").orphaned).toBe(
      false,
    );
  });

  // A seeded first-party default carries no ledger row (the seed install writes
  // none), so for the seed set specifically, absence reads as first-party.
  it("reads a seeded plugin with no provenance fields as verified first-party", () => {
    for (const id of SEED_PLUGIN_IDS) {
      const result = recordProvenance(record({ id, source: "user" }));
      expect(result).toEqual({
        sourceId: FIRST_PARTY_SOURCE_ID,
        sourceLabel: FIRST_PARTY_LABEL,
        curated: true,
        orphaned: false,
      });
      expect(trustTreatmentOf(result)).toBe("verified");
    }
  });

  // The fail-open this closes (CPHMTP-NFR-001, CPHMTP-TC-056 S002-O01). A plugin
  // installed from a raw git URL or local path also carries no ledger row: the
  // install path records none. Absence therefore cannot mean first-party on its
  // own, or arbitrary third-party code wears the green first-party treatment in
  // the installed-plugins tab.
  it("reads a NON-seeded plugin with no provenance fields as unverified, not first-party", () => {
    const result = recordProvenance(record({ id: "totally-evil", source: "user" }));
    expect(result.sourceId).toBe(UNKNOWN_SOURCE_ID);
    expect(result.sourceLabel).toBe(UNKNOWN_SOURCE_LABEL);
    expect(trustTreatmentOf(result)).toBe("unverified");
  });

  // Absence is only consulted when the ledger did not stamp the record: a stamped
  // third-party row stays authoritative even for a seed id (a plugin that took a
  // seed's id cannot buy first-party by name alone).
  it("prefers a stamped source id over the seed-id reading of absence", () => {
    const result = recordProvenance(
      record({ id: "process", sourceId: ACME_SOURCE_ID, unverified: true }),
    );
    expect(result.sourceId).toBe(ACME_SOURCE_ID);
    expect(trustTreatmentOf(result)).toBe("unverified");
  });

  it("derives a third-party record's label from its retained source URL", () => {
    const result = recordProvenance(
      record({
        sourceId: ACME_SOURCE_ID,
        sourceUrl: "https://marketplace.acme.example/catalog.json",
        unverified: true,
      }),
    );
    expect(result.sourceLabel).toBe("marketplace.acme.example");
    expect(trustTreatmentOf(result)).toBe("unverified");
  });

  // The URL is retained precisely so the record reads standalone once the source
  // row is gone, but it is still ledger data: an unparseable one must degrade to
  // something nameable rather than blow up or render an empty chip.
  it("falls back to the raw URL, then the source id, for an unusable source URL", () => {
    expect(
      recordProvenance(record({ sourceId: ACME_SOURCE_ID, sourceUrl: "not a url" })).sourceLabel,
    ).toBe("not a url");
    expect(recordProvenance(record({ sourceId: ACME_SOURCE_ID })).sourceLabel).toBe(ACME_SOURCE_ID);
  });

  it("carries the record's orphaned flag through", () => {
    expect(recordProvenance(record({ sourceId: ACME_SOURCE_ID, orphaned: true })).orphaned).toBe(
      true,
    );
    expect(recordProvenance(record({ sourceId: ACME_SOURCE_ID })).orphaned).toBe(false);
  });
});
