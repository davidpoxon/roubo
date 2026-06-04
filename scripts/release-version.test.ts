import semver from "semver";
import { describe, expect, it } from "vitest";

import { pickLatestPublishedTag, resolveNextTag } from "./release-version.mjs";

const SHA = "a1b2c3d";

describe("resolveNextTag", () => {
  it("bumps patch, minor, and major off the base release", () => {
    expect(resolveNextTag({ baseTag: "v0.1.2", level: "patch", shortSha: SHA })).toBe(
      "v0.1.3-rc.a1b2c3d",
    );
    expect(resolveNextTag({ baseTag: "v0.1.2", level: "minor", shortSha: SHA })).toBe(
      "v0.2.0-rc.a1b2c3d",
    );
    expect(resolveNextTag({ baseTag: "v0.1.2", level: "major", shortSha: SHA })).toBe(
      "v1.0.0-rc.a1b2c3d",
    );
  });

  it("strips the leading v from the base tag", () => {
    expect(resolveNextTag({ baseTag: "0.1.2", level: "patch", shortSha: SHA })).toBe(
      "v0.1.3-rc.a1b2c3d",
    );
  });

  it("produces a valid SemVer version (sans v prefix)", () => {
    const tag = resolveNextTag({ baseTag: "v0.1.2", level: "patch", shortSha: SHA });
    expect(semver.valid(tag.replace(/^v/, ""))).not.toBeNull();
  });

  it("defaults to v0.0.0 when there is no prior release", () => {
    expect(resolveNextTag({ baseTag: null, level: "patch", shortSha: SHA })).toBe(
      "v0.0.1-rc.a1b2c3d",
    );
    expect(resolveNextTag({ baseTag: "", level: "minor", shortSha: SHA })).toBe(
      "v0.1.0-rc.a1b2c3d",
    );
  });

  it("throws on an invalid bump level", () => {
    expect(() => resolveNextTag({ baseTag: "v0.1.2", level: "prerelease", shortSha: SHA })).toThrow(
      /Invalid bump level/,
    );
  });

  it("throws when the short sha is missing", () => {
    expect(() => resolveNextTag({ baseTag: "v0.1.2", level: "patch", shortSha: "" })).toThrow(
      /shortSha/,
    );
  });

  it("throws when the base version is not valid SemVer", () => {
    expect(() =>
      resolveNextTag({ baseTag: "v-not-a-version", level: "patch", shortSha: SHA }),
    ).toThrow(/not valid SemVer/);
  });
});

describe("pickLatestPublishedTag", () => {
  it("prefers the release GitHub marks as latest", () => {
    const releases = [
      { tagName: "v0.2.0", isLatest: false, isDraft: true, isPrerelease: false },
      { tagName: "v0.1.2", isLatest: true, isDraft: false, isPrerelease: false },
      { tagName: "v0.1.1", isLatest: false, isDraft: false, isPrerelease: false },
    ];
    expect(pickLatestPublishedTag(releases)).toBe("v0.1.2");
  });

  it("falls back to the highest non-draft, non-prerelease tag", () => {
    const releases = [
      { tagName: "v0.1.1", isLatest: false, isDraft: false, isPrerelease: false },
      { tagName: "v0.2.0", isLatest: false, isDraft: true, isPrerelease: false },
      { tagName: "v0.1.3-rc.deadbee", isLatest: false, isDraft: false, isPrerelease: true },
      { tagName: "v0.1.2", isLatest: false, isDraft: false, isPrerelease: false },
    ];
    expect(pickLatestPublishedTag(releases)).toBe("v0.1.2");
  });

  it("returns null when only drafts and pre-releases exist", () => {
    const releases = [
      { tagName: "v0.2.0", isLatest: false, isDraft: true, isPrerelease: false },
      { tagName: "v0.1.3-rc.deadbee", isLatest: false, isDraft: false, isPrerelease: true },
    ];
    expect(pickLatestPublishedTag(releases)).toBeNull();
  });

  it("returns null for an empty or non-array input", () => {
    expect(pickLatestPublishedTag([])).toBeNull();
    expect(pickLatestPublishedTag(undefined)).toBeNull();
  });
});
