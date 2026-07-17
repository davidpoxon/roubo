import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";

// The display name for a marketplace source row (issue #561). Lives beside
// MarketplaceSourceRow rather than inside it so the component file exports only
// its component (react-refresh/only-export-components).

const FIRST_PARTY_NAME = "Roubo first-party";

/**
 * The row's display name. The sources API carries no label (a row is only
 * `{ id, url, hasCredential, registeredAt }`), so a third-party name is derived
 * from the URL host, which is the part of the URL a reader recognises. The
 * built-in row is recognised by its reserved id, never by URL-matching: a
 * third-party source registered at the first-party URL is still third-party.
 *
 * A URL the WHATWG parser rejects should never reach here (the server normalises
 * on registration), but fall back to the raw string rather than throwing
 * mid-render.
 */
export function sourceDisplayName(source: MarketplaceSourceSummary): string {
  if (source.id === FIRST_PARTY_SOURCE_ID) return FIRST_PARTY_NAME;
  try {
    return new URL(source.url).host;
  } catch {
    return source.url;
  }
}
