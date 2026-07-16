import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

// Shared guarded-fetch transport (CPHMTP-NFR-002 / NFR-005, issue #554). One
// helper both the catalog fetch (catalog-client.fetchEnvelope) and the artifact
// download (plugin-installer.downloadAssetToFile) route through, so the SSRF /
// redirect guard, the hybrid Authorization rule, and origin-scoped credential
// attach live in exactly one place.
//
// It ports the resolved spike #551 guard shape (canonicalise-then-two-tier
// HARD/SOFT range table, per-hop manual redirect re-validation) and the resolved
// spike #552 credential decision (attach only on exact origin equality, place
// the credential in the Authorization header only). Because the guard follows
// redirects MANUALLY (redirect: "manual", never "follow") so it can re-validate
// each hop before connecting, undici's automatic cross-origin Authorization
// stripping (which only fires on redirect: "follow") does not run. The helper
// therefore OWNS credential attachment per hop: it attaches the credential only
// while the hop origin equals the source origin, and a sticky left-source-origin
// latch guarantees the credential is never re-attached once the chain has left
// the source origin (even if a later hop returns to it). It does not, and must
// not, re-implement undici's stripping. The standing platform tripwire
// undici-authorization-redirect.test.ts pins that undici behaviour separately.

/** Link-local + cloud-metadata: never reachable, consent cannot override. */
export const HARD = "hard-blocked";
/** Loopback / RFC1918 / ULA: reachable only when the origin is the consented source. */
export const SOFT = "soft-blocked";
/** Any other IP literal. */
export const PUBLIC = "public";
/** A non-literal hostname (resolve-and-recheck applies before the connect). */
export const DNS = "dns-name";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Recognised Authorization scheme prefixes sent verbatim (exact case, trailing space). */
const RECOGNISED_AUTH_PREFIXES = ["Bearer ", "Basic ", "token "];

/** Default per-request timeout, matching catalog-client's FETCH_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Default redirect hop cap; a chain longer than this is too-many-redirects. */
export const DEFAULT_MAX_HOPS = 5;

/** A resolved address from a hostname lookup (the shape node:dns lookup returns). */
export interface ResolvedAddress {
  address: string;
}

/** Injectable hostname resolver (defaults to node:dns lookup, all addresses). */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/** Options for a single guarded fetch. Mirrors the architecture contract. */
export interface GuardedFetchOptions {
  /**
   * The consented source origin ("scheme://host[:port]") the fetch is scoped to.
   * The initial hop must equal this origin (or a permitted redirect target), and
   * it is the only origin the credential is ever attached to.
   */
  sourceOrigin: string;
  /**
   * The per-source credential. Attached only as an Authorization header, and only
   * while the hop origin equals sourceOrigin. Undefined / empty / whitespace-only
   * means no credential and no Authorization header.
   */
  credential?: string;
  /**
   * Permit http (the consented-intranet opt-in). Default false: https only. An
   * http hop is rejected as http-not-permitted unless this is set.
   */
  allowHttp?: boolean;
  /**
   * Transport injection (tests / e2e / the undici download path). Defaults to
   * undici's fetch, which is the SAME undici the pinned-connect dispatcher (issue
   * #590) is built from. Node's built-in global fetch bundles a different undici
   * major whose dispatch-handler protocol is incompatible with that dispatcher,
   * so the guarded transport standardises on npm undici to keep the pin working.
   */
  fetchImpl?: typeof fetch;
  /** Redirect hop cap before too-many-redirects. Defaults to DEFAULT_MAX_HOPS. */
  maxHops?: number;
  /**
   * Per-request abort timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. Pass null to
   * disable the timeout for a long-lived streaming download (the artifact path,
   * which is bounded by its own byte cap rather than a wall-clock timeout).
   */
  timeoutMs?: number | null;
  /**
   * Hostname resolver for DNS resolve-and-recheck. Defaults to node:dns lookup.
   * Tests inject a fake so the rebinding recheck runs without real DNS.
   */
  lookup?: LookupFn;
}

/** Thrown when the guard blocks a hop (or the chain exceeds the hop cap). */
export class GuardedFetchError extends Error {
  readonly code = "guarded-fetch-blocked" as const;
  /** The machine-readable guard reason (mirrors the spike #551 rule table). */
  readonly reason: string;
  /** The offending URL, when the block is tied to a specific hop. */
  readonly url?: string;
  constructor(reason: string, message: string, url?: string) {
    super(message);
    this.name = "GuardedFetchError";
    this.reason = reason;
    this.url = url;
  }
}

interface ScopePolicy {
  allowHttp: boolean;
  allowedOrigins: Set<string>;
}

interface HostClassification {
  kind: string;
  ipVersion: number;
  host: string;
}

interface UrlVerdict {
  ok: boolean;
  reason: string;
  classification?: string;
  scheme?: string;
  host?: string;
  origin?: string;
}

/** Strip the surrounding brackets WHATWG URL keeps on an IPv6 hostname. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Classify a dotted-quad IPv4 string into HARD / SOFT / PUBLIC. */
function classifyIPv4(ip: string): string {
  const o = ip.split(".").map((n) => Number(n));
  // 169.254.0.0/16 link-local, contains 169.254.169.254 cloud metadata: HARD.
  if (o[0] === 169 && o[1] === 254) return HARD;
  // 127.0.0.0/8 loopback: SOFT (consent-overridable for a registered local source).
  if (o[0] === 127) return SOFT;
  // 0.0.0.0/8 this-host: SOFT (default-blocked; never a real remote source).
  if (o[0] === 0) return SOFT;
  // RFC1918 private: 10/8, 172.16/12, 192.168/16: SOFT (intranet-consent path).
  if (o[0] === 10) return SOFT;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return SOFT;
  if (o[0] === 192 && o[1] === 168) return SOFT;
  return PUBLIC;
}

/** Expand an IPv6 string (already validated by net.isIP === 6) to 16 bytes. */
export function ipv6ToBytes(addr: string): number[] {
  let head = addr;
  let tail = "";
  const dbl = addr.indexOf("::");
  if (dbl !== -1) {
    head = addr.slice(0, dbl);
    tail = addr.slice(dbl + 2);
  }
  const parseGroups = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);

  // A trailing IPv4-in-IPv6 group (e.g. ::ffff:1.2.3.4) contributes 4 bytes.
  const expandLast = (groups: string[]): number[] => {
    const out: number[] = [];
    groups.forEach((g, i) => {
      if (i === groups.length - 1 && g.includes(".")) {
        for (const part of g.split(".")) out.push(Number(part) & 0xff);
      } else {
        const v = parseInt(g || "0", 16);
        out.push((v >> 8) & 0xff, v & 0xff);
      }
    });
    return out;
  };

  const headBytes = expandLast(headGroups);
  const tailBytes = expandLast(tailGroups);
  const missing = 16 - headBytes.length - tailBytes.length;
  const zeros = new Array(Math.max(0, missing)).fill(0);
  return [...headBytes, ...zeros, ...tailBytes].slice(0, 16);
}

/** Classify an IPv6 string into HARD / SOFT / PUBLIC (recursing for mapped v4). */
function classifyIPv6(ip: string): string {
  const b = ipv6ToBytes(ip);
  // ::1 loopback: SOFT.
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return SOFT;
  // fe80::/10 link-local: HARD (first 10 bits 1111111010).
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return HARD;
  // fc00::/7 unique-local (contains fd00::/8): SOFT.
  if ((b[0] & 0xfe) === 0xfc) return SOFT;
  // ::ffff:a.b.c.d IPv4-mapped: unwrap the embedded IPv4 and re-classify, so a
  // mapped metadata / loopback address inherits the v4 verdict.
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (mapped) return classifyIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  // :: unspecified: SOFT (default-blocked).
  if (b.every((x) => x === 0)) return SOFT;
  return PUBLIC;
}

/** Classify a bare IP literal string (v4 or v6) into HARD / SOFT / PUBLIC. */
function classifyIpLiteral(ip: string): string {
  const v = net.isIP(ip);
  if (v === 4) return classifyIPv4(ip);
  if (v === 6) return classifyIPv6(ip);
  return PUBLIC;
}

/** Classify the host of a parsed URL. */
export function classifyHost(url: URL): HostClassification {
  const host = stripBrackets(url.hostname);
  const v = net.isIP(host);
  if (v === 4) return { kind: classifyIPv4(host), ipVersion: 4, host };
  if (v === 6) return { kind: classifyIPv6(host), ipVersion: 6, host };
  return { kind: DNS, ipVersion: 0, host };
}

/**
 * Validate a single URL against the scheme + range policy (spike #551 shape).
 *
 * hop 0 is the initial fetch (a public / DNS origin must be consented); hop > 0 is
 * a redirect target (a public / DNS target is allowed, e.g. the GHE -> CDN hop).
 */
export function validateSourceUrl(
  rawUrl: string,
  policy: ScopePolicy,
  opts: { hop?: number } = {},
): UrlVerdict {
  const hop = opts.hop ?? 0;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unparseable-url" };
  }

  // Scheme policy: only http(s); http gated behind the consented-intranet flag.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "scheme-not-allowed", scheme: url.protocol };
  }
  if (url.protocol === "http:" && !policy.allowHttp) {
    return { ok: false, reason: "http-not-permitted", scheme: url.protocol };
  }

  const { kind, host } = classifyHost(url);
  const origin = url.origin; // scheme://host[:port], canonicalised by WHATWG
  const consented = policy.allowedOrigins.has(origin);
  const base = { classification: kind, scheme: url.protocol, host, origin };

  // HARD ranges: link-local / cloud-metadata. Never reachable, consent ignored.
  if (kind === HARD) {
    return { ok: false, reason: "hard-blocked-range", ...base };
  }
  // SOFT ranges: loopback / private / ULA. Reachable only when consented.
  if (kind === SOFT) {
    return consented
      ? { ok: true, reason: "soft-range-consented-origin", ...base }
      : { ok: false, reason: "soft-blocked-range-unconsented", ...base };
  }
  // PUBLIC / DNS: initial fetch requires consent; a redirect target does not.
  if (hop === 0) {
    return consented
      ? { ok: true, reason: "consented-origin", ...base }
      : { ok: false, reason: "origin-not-consented", ...base };
  }
  return { ok: true, reason: "public-redirect-target", ...base };
}

/** Whether an HTTP status is a redirect the guard must re-validate. */
export function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Form the Authorization header value from a raw credential (the hybrid rule,
 * CPHMTP-FR-003). A bare value is wrapped as "Bearer <value>"; a value already
 * carrying a recognised scheme prefix ("Bearer " / "Basic " / "token ", exact
 * case) is sent verbatim so it is never double-prefixed; an empty or
 * whitespace-only credential yields no header (null).
 */
export function formAuthorization(credential?: string): string | null {
  if (credential == null || credential.trim().length === 0) return null;
  if (RECOGNISED_AUTH_PREFIXES.some((prefix) => credential.startsWith(prefix))) {
    return credential;
  }
  return `Bearer ${credential}`;
}

/** Default resolver: node:dns lookup returning every A/AAAA record. */
const defaultLookup: LookupFn = (hostname) =>
  dnsLookup(hostname, { all: true }) as Promise<ResolvedAddress[]>;

/**
 * DNS resolve-and-recheck (the named #554 decision point). For a DNS-name host,
 * resolve every A/AAAA record and re-run the range table on each before the
 * connect, so a name that resolves into a blocked range is rejected up front and
 * a DNS-rebinding redirect target cannot pivot to a private / metadata address.
 * A HARD resolved address is always blocked; a SOFT resolved address is blocked
 * unless this hop's origin is the consented source (an intranet DNS source
 * legitimately resolves to a private IP). Resolution errors are swallowed and the
 * hop proceeds: an unresolvable name cannot connect anyway, so the recheck only
 * ever ADDS a block, never a new failure.
 *
 * Returns the validated resolved addresses so the caller can PIN them to the
 * socket connect (issue #590): guardedFetch builds a per-hop undici dispatcher
 * whose connect.lookup answers only with these addresses, so the transport
 * connects to exactly the address that passed the range check and cannot
 * re-resolve to a different (private / metadata) address between this check and
 * the connect. That closes the residual TOCTOU DNS-rebinding window a re-resolve
 * would otherwise leave open. IP-literal hosts and resolution failures return an
 * empty array (nothing to pin: an IP literal has no DNS step, and an unresolvable
 * name lets the transport fall back to its own resolve, so the recheck still only
 * ever ADDS a block, never a new failure).
 */
async function recheckResolvedAddresses(
  classification: string,
  host: string,
  consented: boolean,
  lookup: LookupFn,
  url: string,
): Promise<ResolvedAddress[]> {
  if (classification !== DNS) return []; // IP literals are already classified directly.
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    return []; // Cannot resolve: let the transport fail naturally; add no block, no pin.
  }
  for (const { address } of addresses) {
    const kind = classifyIpLiteral(address);
    if (kind === HARD) {
      throw new GuardedFetchError(
        "hard-blocked-range-resolved",
        `${host} resolves to a link-local / cloud-metadata address (${address}); blocked`,
        url,
      );
    }
    if (kind === SOFT && !consented) {
      throw new GuardedFetchError(
        "soft-blocked-range-resolved-unconsented",
        `${host} resolves to a private / loopback address (${address}) and is not a consented origin; blocked`,
        url,
      );
    }
  }
  return addresses; // Validated: the caller pins exactly these to the connect (issue #590).
}

/**
 * A node net-style connect lookup that answers ONLY with the pre-validated
 * pinned address(es), so the socket connect never performs a second DNS
 * resolution (issue #590). Node's connect path calls a lookup in one of two
 * forms depending on its autoSelectFamily setting: the `all: true` form expects
 * an array of { address, family }, the single form expects (err, address,
 * family). Both are answered here from the same pinned set. Pure and
 * socket-free, so it is unit-testable without a live connection.
 */
export function buildPinnedLookup(addresses: ResolvedAddress[]): net.LookupFunction {
  const records = addresses.map(({ address }) => ({ address, family: net.isIP(address) }));
  return (_hostname, options, callback) => {
    if (options != null && typeof options === "object" && options.all === true) {
      callback(null, records);
      return;
    }
    const first = records[0];
    if (first === undefined) {
      callback(new Error("guarded-fetch: no pinned address to resolve"), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  };
}

/**
 * Build a per-hop undici dispatcher that pins the connect to `addresses` (issue
 * #590). The dispatcher is a fresh Agent whose connector lookup is
 * buildPinnedLookup(addresses). Only npm undici's fetch honours an
 * init.dispatcher, so it is the guarded transport's default and what both the
 * catalog and installer paths inject; Node's built-in global fetch bundles a
 * different undici major whose dispatch-handler protocol does NOT honour this
 * dispatcher, so reverting the transport to global fetch would silently disable
 * the pin. Attaching it forces the connect to the exact validated IP(s) rather
 * than a re-resolved address. Built only for DNS-name hops with a successful
 * validated resolution; IP-literal hops need no pin (no DNS step, no rebind
 * window).
 */
export function buildPinnedDispatcher(addresses: ResolvedAddress[]): Dispatcher {
  return new Agent({ connect: { lookup: buildPinnedLookup(addresses) } });
}

/** RequestInit plus undici's non-standard `dispatcher`, used to pin the connect (issue #590). */
interface DispatcherInit extends RequestInit {
  dispatcher?: Dispatcher;
}

/** Drain and discard a redirect response body so no connection is left hanging. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // best-effort: an already-consumed or bodyless response needs no drain.
  }
}

/**
 * Fetch `url`, guarding SSRF / redirect and scoping the credential.
 *
 * Follows redirects with a MANUAL per-hop loop: each hop is validated (scheme +
 * range table + DNS resolve-and-recheck) BEFORE any request is issued, so a
 * blocked hop is rejected before a packet reaches it. The credential is attached
 * as an Authorization header only while the hop origin equals sourceOrigin, and a
 * sticky latch prevents re-attachment once the chain has left the source origin.
 * Returns the final non-redirect Response so callers keep their own size-cap /
 * streaming logic. Throws GuardedFetchError on a blocked hop or the hop cap.
 */
export async function guardedFetch(url: string, options: GuardedFetchOptions): Promise<Response> {
  const { sourceOrigin, credential } = options;
  const allowHttp = options.allowHttp ?? false;
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof globalThis.fetch);
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const lookup = options.lookup ?? defaultLookup;

  // The one consented origin for this fetch is the source origin itself.
  const policy: ScopePolicy = { allowHttp, allowedOrigins: new Set([sourceOrigin]) };
  const authValue = formAuthorization(credential);

  let current = url;
  let hop = 0;
  // Sticky "left-source-origin" latch: once the chain visits any origin other
  // than sourceOrigin, the credential is never attached again, even on a later
  // hop back to sourceOrigin (satisfies never-re-attach-after-cross-origin).
  let leftSourceOrigin = false;

  for (;;) {
    const verdict = validateSourceUrl(current, policy, { hop });
    if (!verdict.ok) {
      throw new GuardedFetchError(
        verdict.reason,
        `guarded-fetch blocked ${current}: ${verdict.reason}`,
        current,
      );
    }

    const atSourceOrigin = verdict.origin === sourceOrigin;
    if (!atSourceOrigin) leftSourceOrigin = true;

    // Re-run the range table against every resolved address before connecting,
    // and keep the validated resolution so it can be pinned to the connect.
    const pinnedAddresses = await recheckResolvedAddresses(
      verdict.classification ?? DNS,
      verdict.host ?? "",
      policy.allowedOrigins.has(verdict.origin ?? ""),
      lookup,
      current,
    );

    // Attach the credential only on the exact source origin, and never once the
    // chain has left it. Placed in the Authorization header only, never in the
    // URL, a query string, a cookie, the Referer, or the body.
    const headers: Record<string, string> = {};
    if (authValue !== null && atSourceOrigin && !leftSourceOrigin) {
      headers.authorization = authValue;
    }

    const init: DispatcherInit = { redirect: "manual", headers };
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    // Pin the exact validated IP(s) to the socket connect (issue #590): for a
    // DNS-name hop whose resolution passed the range table, force the transport to
    // connect to precisely those addresses so it cannot re-resolve the name to a
    // different (private / metadata) address between the check and the connect.
    // pinnedAddresses is empty for IP literals and for resolution failures, so
    // those hops keep the transport's own connect unchanged.
    if (pinnedAddresses.length > 0) {
      init.dispatcher = buildPinnedDispatcher(pinnedAddresses);
    }

    const res = await fetchImpl(current, init);

    if (isRedirect(res.status)) {
      const location = res.headers.get("location");
      if (location !== null) {
        if (hop + 1 > maxHops) {
          await discardBody(res);
          throw new GuardedFetchError(
            "too-many-redirects",
            `guarded-fetch exceeded the ${maxHops}-hop redirect cap`,
            current,
          );
        }
        await discardBody(res);
        current = new URL(location, current).toString(); // resolve relative Location
        hop += 1;
        continue;
      }
    }
    return res;
  }
}
