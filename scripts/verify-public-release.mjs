// Guard for the one release failure nothing else catches: a published release
// that is missing from, or not first in, the PUBLIC releases listing.
//
// `update.electronjs.org` resolves the latest version from exactly one endpoint,
// walks it in order, skips drafts and pre-releases, and serves the FIRST entry
// carrying a matching asset. It never calls `releases/latest`. So a release that
// is absent from that listing, or listed below an older one, reaches nobody,
// while the workflow stays green, the release page renders, the tag resolves,
// `releases/latest` returns the new version, and the assets download.
//
// AUTHENTICATION: every request this module makes is UNAUTHENTICATED, by design.
// That is the whole point of the check. A token (GITHUB_TOKEN, or shelling out
// to `gh`) authenticates as a principal with push access, which sees the release
// even when the public cannot, and would mask the exact failure being guarded
// against. Do not "tidy" any of this into `gh`.
//
// See docs/releasing.md, "Verifying a public release", for the manual equivalent
// and "Troubleshooting: a published release is not offered to users" for the fix.

export const RELEASES_URL = "https://api.github.com/repos/davidpoxon/roubo/releases?per_page=100";

// arm64 is the only active row in the release build matrix. If the x64 or Linux
// rows are uncommented, this soft check needs a platform per row.
export const UPDATE_FEED_BASE_URL = "https://update.electronjs.org/davidpoxon/roubo/darwin-arm64";

export const POLL_ATTEMPTS = 6;
export const POLL_INTERVAL_MS = 20_000;

const USER_AGENT = "roubo-release-guard";

const FIX_POINTER =
  'Fix: toggle the pre-release flag to force a listing reindex, per "Troubleshooting: ' +
  'a published release is not offered to users" in docs/releasing.md.';

const LIKELY_CAUSE =
  "The likely cause is a GitHub-side listing-index inconsistency, where the release " +
  "record reads as published while the public list index still behaves as though it " +
  "were a draft.";

/**
 * Wait for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Classify an HTTP status from the unauthenticated releases listing.
 *
 * 403 is how the unauthenticated GitHub API reports a per-IP rate limit, and
 * Actions runners share egress addresses, so a busy pool can hit it. 429 is the
 * documented secondary-limit code. Neither is evidence that the tag is missing,
 * so both must be reported distinctly rather than folded into a listing verdict.
 *
 * @param {number} status
 * @returns {"ok"|"rate-limited"|"http-error"}
 */
export function classifyStatus(status) {
  if (status === 200) {
    return "ok";
  }
  if (status === 403 || status === 429) {
    return "rate-limited";
  }
  return "http-error";
}

/**
 * Decide whether a tag is present, and first, in the listing order.
 *
 * "First" is load-bearing: the update service takes the first matching release
 * rather than the highest version, so a new release listed below an older one
 * leaves every user on the older build.
 *
 * @param {string[]} tags Tag names in listing order.
 * @param {string} tag The release tag being verified.
 * @returns {{verdict: "ok"|"missing"|"not-first", index: number, first: string|null}}
 */
export function assertTagIsFirst(tags, tag) {
  const list = Array.isArray(tags) ? tags : [];
  const first = list.length > 0 ? list[0] : null;
  const index = list.indexOf(tag);

  if (index === -1) {
    return { verdict: "missing", index: -1, first };
  }
  if (index > 0) {
    return { verdict: "not-first", index, first };
  }
  return { verdict: "ok", index: 0, first };
}

/**
 * Resolve the version users are upgrading *from*, for the soft update-feed check.
 *
 * The listing is ordered newest first, so the previous published version is the
 * first non-draft, non-prerelease entry below the tag being verified. Deliberately
 * dependency-free (no semver import) so the release job can run this script from a
 * bare checkout without `npm ci`.
 *
 * @param {Array<{tag_name?: string, draft?: boolean, prerelease?: boolean}>} releases
 * @param {string} tag
 * @returns {string|null} The previous published version without its leading "v", or null.
 */
export function resolvePreviousVersion(releases, tag) {
  if (!Array.isArray(releases)) {
    return null;
  }

  const index = releases.findIndex((r) => r && r.tag_name === tag);
  const below = index === -1 ? releases : releases.slice(index + 1);
  const previous = below.find(
    (r) =>
      r &&
      typeof r.tag_name === "string" &&
      r.tag_name !== tag &&
      r.draft !== true &&
      r.prerelease !== true,
  );

  return previous ? previous.tag_name.replace(/^v/, "") : null;
}

/**
 * Fetch the public releases listing once, unauthenticated.
 *
 * @param {{fetchImpl?: typeof fetch, url?: string}} [options]
 * @returns {Promise<{outcome: "ok"|"rate-limited"|"http-error"|"transport-error", status?: number, releases?: Array<object>, detail?: string}>}
 */
export async function fetchPublicListing({ fetchImpl = fetch, url = RELEASES_URL } = {}) {
  let response;
  try {
    // No Authorization header, ever. See the authentication note at the top.
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    });
  } catch (error) {
    return { outcome: "transport-error", detail: errorMessage(error) };
  }

  const outcome = classifyStatus(response.status);
  if (outcome !== "ok") {
    return { outcome, status: response.status };
  }

  try {
    const body = await response.json();
    return { outcome: "ok", status: response.status, releases: Array.isArray(body) ? body : [] };
  } catch (error) {
    return { outcome: "transport-error", detail: `listing was not JSON: ${errorMessage(error)}` };
  }
}

/**
 * Poll the public listing until the tag is present and first, or the attempts run out.
 *
 * The listing is eventually consistent, so a single request would produce false
 * failures on ordinary propagation lag.
 *
 * @param {{tag: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, attempts?: number, intervalMs?: number, log?: (message: string) => void}} options
 * @returns {Promise<{verdict: "ok"|"missing"|"not-first"|"rate-limited"|"unavailable", attempts: number, check?: {verdict: string, index: number, first: string|null}, releases?: Array<object>, status?: number, detail?: string}>}
 */
export async function pollPublicListing({
  tag,
  fetchImpl = fetch,
  sleep = defaultSleep,
  attempts = POLL_ATTEMPTS,
  intervalMs = POLL_INTERVAL_MS,
  log = console.log,
} = {}) {
  let last = { outcome: "transport-error", detail: "no attempt was made" };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await fetchPublicListing({ fetchImpl });

    if (result.outcome === "ok") {
      const tags = (result.releases ?? [])
        .map((r) => (r && typeof r.tag_name === "string" ? r.tag_name : null))
        .filter((t) => t !== null);
      const check = assertTagIsFirst(tags, tag);
      log(
        `Attempt ${attempt}/${attempts}: ${tags.length} release(s) listed publicly, ${tag} is ${check.verdict}.`,
      );
      if (check.verdict === "ok") {
        return { verdict: "ok", attempts: attempt, check, releases: result.releases };
      }
      last = { ...result, check };
    } else {
      const suffix = result.status === undefined ? result.detail : `HTTP ${result.status}`;
      log(`Attempt ${attempt}/${attempts}: listing unavailable (${result.outcome}: ${suffix}).`);
      last = result;
    }

    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }

  if (last.outcome === "ok") {
    return {
      verdict: last.check.verdict,
      attempts,
      check: last.check,
      releases: last.releases,
    };
  }
  if (last.outcome === "rate-limited") {
    return { verdict: "rate-limited", attempts, status: last.status };
  }
  return {
    verdict: "unavailable",
    attempts,
    status: last.status,
    detail: last.detail,
  };
}

/**
 * Soft check: does the update feed already offer the new version to someone on the
 * previous release? This NEVER fails the workflow. The service caches its per-repo
 * result for roughly 15 minutes, so a 204 straight after publishing is expected.
 *
 * @param {{releases: Array<object>, tag: string, fetchImpl?: typeof fetch, log?: (message: string) => void}} options
 * @returns {Promise<"offered"|"stale"|"skipped"|"unknown">}
 */
export async function checkUpdateFeed({ releases, tag, fetchImpl = fetch, log = console.log }) {
  const previous = resolvePreviousVersion(releases, tag);
  if (previous === null) {
    log("No previous published release in the listing, so the update-feed check is skipped.");
    return "skipped";
  }

  const url = `${UPDATE_FEED_BASE_URL}/${previous}`;
  try {
    const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
    if (response.status === 204) {
      log(
        `::warning::The update feed still reports ${previous} as current (HTTP 204) instead of ` +
          `offering ${tag}. update.electronjs.org caches its per-repo result for roughly 15 ` +
          "minutes, so this is expected straight after publishing and is not a failure. Re-run " +
          "check 2 in docs/releasing.md until it flips.",
      );
      return "stale";
    }
    if (response.status === 200) {
      log(`The update feed offers an upgrade to users on ${previous}.`);
      return "offered";
    }
    log(`::warning::The update feed returned HTTP ${response.status} for ${url}.`);
    return "unknown";
  } catch (error) {
    log(`::warning::Could not reach the update feed at ${url}: ${errorMessage(error)}.`);
    return "unknown";
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const tag = (process.env.RELEASE_TAG ?? "").trim();
  if (tag === "") {
    console.error("::error::RELEASE_TAG is not set, so there is no release to verify.");
    process.exitCode = 1;
    return;
  }

  const windowSeconds = Math.round((POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000);
  console.log(
    `Verifying ${tag} is present, and first, in the public unauthenticated releases listing ` +
      `(${POLL_ATTEMPTS} attempts, ${POLL_INTERVAL_MS / 1000}s apart).`,
  );

  const result = await pollPublicListing({ tag });

  if (result.verdict === "missing") {
    console.error(
      `::error::Release ${tag} is absent from the public releases listing after ` +
        `${result.attempts} attempts over roughly ${windowSeconds}s. update.electronjs.org ` +
        `reads only this listing, so no user will ever be offered ${tag}. ${LIKELY_CAUSE} ` +
        FIX_POINTER,
    );
    process.exitCode = 1;
    return;
  }

  if (result.verdict === "not-first") {
    console.error(
      `::error::Release ${tag} appears in the public releases listing at position ` +
        `${result.check.index + 1}, behind ${result.check.first}, after ${result.attempts} ` +
        `attempts over roughly ${windowSeconds}s. update.electronjs.org takes the first ` +
        `matching release rather than the highest version, so users would be offered ` +
        `${result.check.first} instead of ${tag}. ${LIKELY_CAUSE} ${FIX_POINTER}`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.verdict === "rate-limited") {
    console.error(
      `::error::The public releases listing could not be read: GitHub returned HTTP ` +
        `${result.status} on all ${result.attempts} attempts. That is the unauthenticated ` +
        `per-IP rate limit, which Actions runners share, and it is not evidence that ${tag} ` +
        "is missing from the listing. Re-run this job. Do not add a token to get past it: an " +
        "authenticated request sees releases the public cannot, which is the failure this " +
        "job exists to catch.",
    );
    process.exitCode = 1;
    return;
  }

  if (result.verdict === "unavailable") {
    console.error(
      `::error::The public releases listing could not be read after ${result.attempts} ` +
        `attempts (${result.detail ?? `HTTP ${result.status}`}), so ${tag} could not be ` +
        "verified. Re-run this job.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${tag} is the first entry in the public releases listing.`);

  // Soft check only. It reports, it never fails the release.
  await checkUpdateFeed({ releases: result.releases ?? [], tag });
}

// Run the CLI only when invoked directly, not when imported by the test suite.
if (process.argv[1] && process.argv[1].endsWith("verify-public-release.mjs")) {
  await main();
}
