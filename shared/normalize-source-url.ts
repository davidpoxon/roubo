// Shared marketplace source URL normalisation (CPHMTP-FR-007, issue #565).
//
// A single WHATWG-URL normalisation used on BOTH sides of the trust boundary:
//   - the server's registration path (marketplace-sources-state.ts) persists the
//     normalised href as the source's canonical `url`, and
//   - the client's project-open offer compares a project's declared
//     `marketplaces[].url` against that persisted href to decide whether a
//     declared source is already registered.
//
// Sharing the one function is what makes those two comparisons agree: a declared
// URL that differs from a registered source only by scheme/host casing or a
// trailing slash normalises to the same href and so shows no duplicate offer
// (CPHMTP-TC-080). The WHATWG URL parser lower-cases the scheme and host, drops a
// default port, and canonicalises an empty path to "/", so those spellings all
// collapse to one href.
//
// This performs NO network call: it only parses and canonicalises the string
// (CPHMTP-NFR-003).

/**
 * Parses a marketplace source URL and returns its WHATWG-normalised `href`, or
 * `null` when the value is not a well-formed http(s) URL. The scheme must be
 * `https:` or `http:`; any other scheme (or a non-URL value) yields `null`.
 *
 * The returned href is the canonical form both the client comparison and the
 * server registration key off, so two spellings of the same endpoint (casing,
 * trailing slash, default port) compare equal.
 */
export function normalizeSourceUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  return parsed.href;
}
