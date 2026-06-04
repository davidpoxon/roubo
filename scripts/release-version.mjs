// Pure, side-effect-free helpers for computing the next draft-release tag.
// Kept separate from the orchestrator (draft-release.mjs) so the version math
// is unit-testable without shelling out to git or gh.

import semver from "semver";

const LEVELS = new Set(["patch", "minor", "major"]);

/**
 * Strip a single leading "v" from a tag and trim surrounding whitespace.
 * @param {string} tag
 * @returns {string}
 */
function stripV(tag) {
  return tag.replace(/^v/, "").trim();
}

/**
 * Compute the next draft-release tag.
 *
 * The result follows the SemVer pre-release format (spec item 9): the bumped
 * release version, then "-rc." and the short commit sha as the pre-release
 * identifier (e.g. "v0.1.3-rc.a1b2c3d"). The "rc" identifier guarantees the
 * first pre-release identifier is non-numeric, sidestepping the SemVer rule
 * that a numeric identifier must not carry a leading zero (an all-numeric sha
 * could otherwise be invalid).
 *
 * @param {object} params
 * @param {string|null|undefined} params.baseTag Latest published tag (e.g. "v0.1.2"); null/empty means no prior release.
 * @param {"patch"|"minor"|"major"} params.level Which part to bump.
 * @param {string} params.shortSha Short commit sha used as the pre-release identifier.
 * @returns {string} The new tag, e.g. "v0.1.3-rc.a1b2c3d".
 */
export function resolveNextTag({ baseTag, level, shortSha }) {
  if (!LEVELS.has(level)) {
    throw new Error(`Invalid bump level "${level}". Expected one of: patch, minor, major.`);
  }
  if (typeof shortSha !== "string" || shortSha.trim() === "") {
    throw new Error("A non-empty shortSha is required to build the pre-release identifier.");
  }

  const rawBase = baseTag == null ? "" : stripV(baseTag);
  const base = rawBase === "" ? "0.0.0" : rawBase;
  if (!semver.valid(base)) {
    throw new Error(`Base version "${baseTag}" is not valid SemVer.`);
  }

  const next = semver.inc(base, level);
  return `v${next}-rc.${shortSha.trim()}`;
}

/**
 * Pick the base tag to bump from out of the parsed `gh release list` array.
 *
 * Prefers the release GitHub marks as `isLatest` (which already excludes drafts
 * and pre-releases). Falls back to the highest SemVer tag among non-draft,
 * non-prerelease entries. Returns null when nothing qualifies.
 *
 * @param {Array<{tagName?: string, isLatest?: boolean, isDraft?: boolean, isPrerelease?: boolean}>} releases
 * @returns {string|null}
 */
export function pickLatestPublishedTag(releases) {
  if (!Array.isArray(releases)) {
    return null;
  }

  const latest = releases.find((r) => r && r.isLatest && typeof r.tagName === "string");
  if (latest) {
    return latest.tagName;
  }

  const published = releases
    .filter(
      (r) =>
        r &&
        !r.isDraft &&
        !r.isPrerelease &&
        typeof r.tagName === "string" &&
        semver.valid(stripV(r.tagName)),
    )
    .map((r) => r.tagName);

  if (published.length === 0) {
    return null;
  }

  published.sort((a, b) => semver.rcompare(stripV(a), stripV(b)));
  return published[0];
}
