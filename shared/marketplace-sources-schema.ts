import { z } from "zod";

// Issue #553 / CPHMTP-FR-001, CPHMTP-FR-003, CPHMTP-NFR-002, CPHMTP-NFR-003.
// Persistent registry of third-party marketplace sources. See:
//   .specifications/component-plugins-hosted-marketplace-third-party/prd.md
//     (CPHMTP-FR-001, CPHMTP-FR-002, CPHMTP-FR-003, CPHMTP-NFR-002, CPHMTP-NFR-003)
//   .specifications/component-plugins-hosted-marketplace-third-party/architecture.md
//     ('Data model' MarketplaceSource row, 'Client -> sources API')
//
// Structural sibling of plugin-consent-schema.ts. A registered source is an
// unsigned, consent-gated marketplace: the persisted row doubles as the FR-002
// registration consent record (URL + unsigned status + timestamp per
// CPHMTP-NFR-003). The credential itself never lives in this file: it is stored
// in the OS keyring and the row carries only a `hasCredential` boolean.

export const MARKETPLACE_SOURCES_STATE_SCHEMA_VERSION = 1 as const;

/**
 * The reserved id of the built-in first-party catalog: the always-present,
 * non-removable source. Shared (rather than server-local) because the client
 * needs it too, to tell a first-party listing's provenance chip from a
 * third-party one (CPHMTP-FR-004, issue #557). It can never collide with a
 * generated third-party id: generated ids end in an 8-char hex suffix, and
 * "party" is not hex.
 */
export const FIRST_PARTY_SOURCE_ID = "first-party";

export const MarketplaceSourceSchema = z
  .object({
    // Generated slug derived from the source URL: filesystem- and keyring-safe
    // (`[a-z0-9-]`), stable for a given URL so a re-registration resolves to the
    // same row and keyring account.
    id: z.string().min(1),
    // The raw catalog URL exactly as consented (WHATWG-normalised href).
    url: z.string().min(1),
    // Every registered source is unsigned by construction: the signed first-party
    // chain is unreachable from third-party sources (CPHMTP-NFR-001).
    unsigned: z.literal(true),
    // True when a credential is stored in the keyring under `source:<id>/token`.
    hasCredential: z.boolean(),
    // Per-source "allow http (intranet)" opt-in captured at registration consent
    // (Spike 551). Defaults to false; https is always allowed and a plain-http
    // source is fetchable only when this flag is set. Kept out of the sources API
    // GET response shape (an internal registration detail).
    allowHttp: z.boolean(),
    // ISO timestamp of registration; the consent record's trust-at-registration
    // stamp (CPHMTP-NFR-003).
    registeredAt: z.string().min(1),
  })
  .strict();
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

export const MarketplaceSourcesStateSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_SOURCES_STATE_SCHEMA_VERSION),
    sources: z.array(MarketplaceSourceSchema),
  })
  .strict();
export type MarketplaceSourcesState = z.infer<typeof MarketplaceSourcesStateSchema>;

/**
 * The projection returned by the sources API (`GET /api/marketplace/sources`).
 * Never carries the credential; only the `hasCredential` boolean. `unsigned` and
 * `allowHttp` are registration internals and stay out of this shape.
 */
export interface MarketplaceSourceSummary {
  id: string;
  url: string;
  hasCredential: boolean;
  registeredAt: string;
}
