import type { FetchTransport } from "./transport.js";

/**
 * Parses an RFC-5988 Link header into a `rel -> URL` map. GitHub uses this on
 * every paginated REST endpoint (e.g. `Link: <https://api.github.com/...?page=2>; rel="next", <...>; rel="last"`).
 * Accepts the `string | string[]` shape that `host.fetch` may surface for
 * repeated headers; arrays are joined with commas so the same parser walks them.
 *
 * Uses linear string indexing rather than a regex with `\s*` quantifiers, to
 * avoid polynomial backtracking on adversarial inputs (CodeQL js/polynomial-redos).
 */
export function parseLinkHeader(value: string | string[] | undefined): Record<string, string> {
  if (!value) return {};
  const joined = Array.isArray(value) ? value.join(", ") : value;
  const out: Record<string, string> = {};
  for (const rawPart of joined.split(",")) {
    const part = rawPart.trim();
    // Expect "<url>; rel=\"name\"" (possibly with additional ;-separated params).
    if (part.charCodeAt(0) !== 0x3c /* '<' */) continue;
    const urlEnd = part.indexOf(">", 1);
    if (urlEnd < 0) continue;
    const url = part.slice(1, urlEnd);
    // Search the remainder for a `rel="..."` param. indexOf is linear, no backtracking.
    const relKey = part.indexOf('rel="', urlEnd + 1);
    if (relKey < 0) continue;
    const relStart = relKey + 'rel="'.length;
    const relEnd = part.indexOf('"', relStart);
    if (relEnd < 0) continue;
    const rel = part.slice(relStart, relEnd);
    if (rel.length > 0) out[rel] = url;
  }
  return out;
}

function getHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

export interface PaginateOptions {
  /** Optional per-call `init` (e.g. `allowSelfSignedTls` for GHE). */
  init?: { allowSelfSignedTls?: boolean; headers?: Record<string, string> };
  /** Hard cap on pages walked, to bound runaway loops. Default 100. */
  maxPages?: number;
}

/**
 * Follows GitHub's `Link: rel="next"` header to walk a paginated REST listing
 * and concatenates each page's JSON body. Each page body is expected to parse
 * to `T[]`; non-array bodies surface as a clear error. Stops as soon as no
 * `next` link is present.
 */
export async function paginateAlerts<T>(
  transport: FetchTransport,
  initialUrl: string,
  options: PaginateOptions = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? 100;
  const init = {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.init?.headers ?? {}),
    },
    ...(options.init?.allowSelfSignedTls ? { allowSelfSignedTls: true } : {}),
  };

  const out: T[] = [];
  let url: string | undefined = initialUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    const res = await transport(url, init);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `[shared-github] paginateAlerts: ${init.method} ${url} returned status ${res.status}`,
      );
    }
    const parsed: unknown = res.body.length === 0 ? [] : JSON.parse(res.body);
    if (!Array.isArray(parsed)) {
      throw new Error(`[shared-github] paginateAlerts: ${url} response body was not a JSON array`);
    }
    out.push(...(parsed as T[]));
    pages += 1;
    const links = parseLinkHeader(getHeader(res.headers, "link"));
    url = links.next;
  }
  return out;
}
