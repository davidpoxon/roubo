// The trust derivation behind the shared badge (CPHMTP-FR-006 / CPHMTP-NFR-001 /
// CPHMTP-US-005, issue #563). CPHMTP-NFR-001 requires "0 UI states where a
// third-party plugin renders first-party verified styling" (CPHMTP-TC-056
// S002-O01). Every plugin surface renders ProvenanceBadge and nothing else
// decides trust, so that property reduces to this one function: if the verified
// treatment is unreachable here for a non-first-party source, it is unreachable
// everywhere. These tests pin the gate, including against a hostile catalog
// injecting `verified: true` (CPHMTP-TC-072 S001).

import { describe, it, expect } from "vitest";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";

// Well-known first-party plugin ids (formerly the retired SEED_PLUGIN_IDS set,
// davidpoxon/roubo-development#621). Declared locally now that the app no longer
// exports a seed set: the point of these cases is that even a well-known
// first-party id earns no trust by name, only by a stamped ledger row (#607).
const FIRST_PARTY_PLUGIN_IDS = ["github-com", "process", "database"] as const;
import {
  FIRST_PARTY_LABEL,
  UNKNOWN_SOURCE_ID,
  UNKNOWN_SOURCE_LABEL,
  isFirstPartySource,
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

// Catalog signing is a SOURCE property, decoupled from the per-entry curation flag
// that `trustTreatmentOf` gates on (issue #603). An uncurated first-party entry is
// still signed by Roubo (the catalog it reached the UI through validated), even
// though it grades unverified for curation.
describe("isFirstPartySource: the source-signature predicate (issue #603)", () => {
  it("is true for a first-party provenance regardless of the curation flag", () => {
    expect(isFirstPartySource(provenance({ curated: true }))).toBe(true);
    expect(isFirstPartySource(provenance({ curated: false }))).toBe(true);
  });

  it("is false for a third-party source id", () => {
    expect(isFirstPartySource(provenance({ sourceId: ACME_SOURCE_ID }))).toBe(false);
    expect(isFirstPartySource(provenance({ sourceId: UNKNOWN_SOURCE_ID }))).toBe(false);
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

  // The durable fix (#607): every install path now stamps a ledger row, so the
  // client no longer reads a well-known first-party id as first-party on absence.
  // Such an id with no provenance fields (in practice a record predating the
  // ledger) fails closed to unverified, exactly like any other unstamped record:
  // the self-asserted id is not a trust root.
  it("fails a first-party id with no provenance fields closed to unverified, not first-party", () => {
    for (const id of FIRST_PARTY_PLUGIN_IDS) {
      const result = recordProvenance(record({ id, source: "user" }));
      expect(result.sourceId).toBe(UNKNOWN_SOURCE_ID);
      expect(result.sourceLabel).toBe(UNKNOWN_SOURCE_LABEL);
      expect(trustTreatmentOf(result)).toBe("unverified");
    }
  });

  // A first-party install carries a STAMPED first-party row (the install writes
  // one, #607), and that row, not the id, is what earns the verified treatment.
  it("reads a first-party plugin carrying a stamped first-party row as verified first-party", () => {
    for (const id of FIRST_PARTY_PLUGIN_IDS) {
      const result = recordProvenance(
        record({
          id,
          source: "user",
          sourceId: FIRST_PARTY_SOURCE_ID,
          sourceUrl: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
          unverified: false,
        }),
      );
      expect(result).toEqual({
        sourceId: FIRST_PARTY_SOURCE_ID,
        sourceLabel: FIRST_PARTY_LABEL,
        curated: true,
        orphaned: false,
      });
      expect(trustTreatmentOf(result)).toBe("verified");
    }
  });

  // The fail-open this closes (CPHMTP-NFR-001, CPHMTP-TC-056 S002-O01). Absence
  // fails closed regardless of id: a record with no provenance fields grades
  // unverified, so arbitrary code can never wear the green first-party treatment
  // in the installed-plugins tab by carrying no row (#607).
  it("reads an unknown plugin with no provenance fields as unverified, not first-party", () => {
    const result = recordProvenance(record({ id: "totally-evil", source: "user" }));
    expect(result.sourceId).toBe(UNKNOWN_SOURCE_ID);
    expect(result.sourceLabel).toBe(UNKNOWN_SOURCE_LABEL);
    expect(trustTreatmentOf(result)).toBe("unverified");
  });

  // A stamped row is always authoritative, even for a well-known first-party id: a
  // plugin that took a first-party id but carries a third-party row cannot buy
  // first-party by name.
  it("prefers a stamped third-party source id even for a first-party id", () => {
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
