import { describe, expect, it, vi } from "vitest";

import {
  assertTagIsFirst,
  checkUpdateFeed,
  classifyStatus,
  pollPublicListing,
  resolvePreviousVersion,
} from "./verify-public-release.mjs";

type ListedRelease = { tag_name: string; draft?: boolean; prerelease?: boolean };

/** Build a fetch stub that returns the given JSON listing with HTTP 200. */
function listingResponse(releases: ListedRelease[]) {
  return { status: 200, json: async () => releases };
}

function statusResponse(status: number) {
  return { status, json: async () => [] };
}

const noSleep = async () => {};

describe("classifyStatus", () => {
  it("treats 403 and 429 as rate limiting, not as a missing tag", () => {
    expect(classifyStatus(403)).toBe("rate-limited");
    expect(classifyStatus(429)).toBe("rate-limited");
  });

  it("treats 200 as ok and anything else as an http error", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(404)).toBe("http-error");
    expect(classifyStatus(500)).toBe("http-error");
  });
});

describe("assertTagIsFirst", () => {
  it("passes when the tag is the first entry", () => {
    expect(assertTagIsFirst(["v0.2.1", "v0.2.0"], "v0.2.1")).toEqual({
      verdict: "ok",
      index: 0,
      first: "v0.2.1",
    });
  });

  it("reports a tag missing from the listing", () => {
    expect(assertTagIsFirst(["v0.2.0", "v0.1.9"], "v0.2.1")).toEqual({
      verdict: "missing",
      index: -1,
      first: "v0.2.0",
    });
  });

  it("reports a tag that is present but not first", () => {
    expect(assertTagIsFirst(["v0.2.0", "v0.2.1", "v0.1.9"], "v0.2.1")).toEqual({
      verdict: "not-first",
      index: 1,
      first: "v0.2.0",
    });
  });

  it("reports missing for an empty listing", () => {
    expect(assertTagIsFirst([], "v0.2.1")).toEqual({ verdict: "missing", index: -1, first: null });
  });
});

describe("resolvePreviousVersion", () => {
  it("returns the first published release below the tag, stripped of its v", () => {
    const releases: ListedRelease[] = [
      { tag_name: "v0.2.1", draft: false, prerelease: false },
      { tag_name: "v0.2.0", draft: false, prerelease: false },
      { tag_name: "v0.1.9", draft: false, prerelease: false },
    ];
    expect(resolvePreviousVersion(releases, "v0.2.1")).toBe("0.2.0");
  });

  it("skips drafts and pre-releases", () => {
    const releases: ListedRelease[] = [
      { tag_name: "v0.2.1", draft: false, prerelease: false },
      { tag_name: "v0.2.1-rc.deadbee", draft: false, prerelease: true },
      { tag_name: "v0.2.0-draft", draft: true, prerelease: false },
      { tag_name: "v0.2.0", draft: false, prerelease: false },
    ];
    expect(resolvePreviousVersion(releases, "v0.2.1")).toBe("0.2.0");
  });

  it("returns null when nothing published sits below the tag", () => {
    const releases: ListedRelease[] = [{ tag_name: "v0.1.0", draft: false, prerelease: false }];
    expect(resolvePreviousVersion(releases, "v0.1.0")).toBeNull();
    expect(resolvePreviousVersion([], "v0.1.0")).toBeNull();
  });
});

describe("pollPublicListing", () => {
  it("passes when the tag is first (AC1 satisfied)", async () => {
    const fetchImpl = vi.fn(async () =>
      listingResponse([{ tag_name: "v0.2.1" }, { tag_name: "v0.2.0" }]),
    );

    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
      attempts: 3,
      intervalMs: 0,
      log: () => {},
    });

    expect(result.verdict).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never sends an Authorization header", async () => {
    const fetchImpl = vi.fn(async () => listingResponse([{ tag_name: "v0.2.1" }]));

    await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
      attempts: 1,
      intervalMs: 0,
      log: () => {},
    });

    const headers = (fetchImpl.mock.calls[0] as unknown as [string, { headers: object }])[1]
      .headers;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("fails when the tag is missing from the listing (AC1)", async () => {
    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: (async () => listingResponse([{ tag_name: "v0.2.0" }])) as never,
      sleep: noSleep,
      attempts: 2,
      intervalMs: 0,
      log: () => {},
    });

    expect(result.verdict).toBe("missing");
    expect(result.attempts).toBe(2);
  });

  it("fails when the tag is present but not first (AC2)", async () => {
    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: (async () =>
        listingResponse([{ tag_name: "v0.2.0" }, { tag_name: "v0.2.1" }])) as never,
      sleep: noSleep,
      attempts: 2,
      intervalMs: 0,
      log: () => {},
    });

    expect(result.verdict).toBe("not-first");
    expect(result.check?.index).toBe(1);
    expect(result.check?.first).toBe("v0.2.0");
  });

  it("does not fail on transient listing lag: retries then succeeds (AC6)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listingResponse([{ tag_name: "v0.2.0" }]))
      .mockResolvedValueOnce(listingResponse([{ tag_name: "v0.2.0" }, { tag_name: "v0.2.1" }]))
      .mockResolvedValue(listingResponse([{ tag_name: "v0.2.1" }, { tag_name: "v0.2.0" }]));
    const sleep = vi.fn(async () => {});

    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: fetchImpl as never,
      sleep,
      attempts: 6,
      intervalMs: 20_000,
      log: () => {},
    });

    expect(result.verdict).toBe("ok");
    expect(result.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(20_000);
  });

  it("reports a persistent 403 as rate limiting rather than a missing tag", async () => {
    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: (async () => statusResponse(403)) as never,
      sleep: noSleep,
      attempts: 3,
      intervalMs: 0,
      log: () => {},
    });

    expect(result.verdict).toBe("rate-limited");
    expect(result.status).toBe(403);
  });

  it("reports an unreachable listing as unavailable", async () => {
    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as never,
      sleep: noSleep,
      attempts: 2,
      intervalMs: 0,
      log: () => {},
    });

    expect(result.verdict).toBe("unavailable");
    expect(result.detail).toContain("ECONNRESET");
  });

  it("recovers from a rate-limited attempt and still passes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(403))
      .mockResolvedValue(listingResponse([{ tag_name: "v0.2.1" }]));

    const result = await pollPublicListing({
      tag: "v0.2.1",
      fetchImpl: fetchImpl as never,
      sleep: noSleep,
      attempts: 3,
      intervalMs: 0,
      log: () => {},
    });

    expect(result.verdict).toBe("ok");
    expect(result.attempts).toBe(2);
  });
});

describe("checkUpdateFeed", () => {
  const releases: ListedRelease[] = [
    { tag_name: "v0.2.1", draft: false, prerelease: false },
    { tag_name: "v0.2.0", draft: false, prerelease: false },
  ];

  it("warns without failing when the feed still reports the previous version as current", async () => {
    const log = vi.fn();
    const outcome = await checkUpdateFeed({
      releases,
      tag: "v0.2.1",
      fetchImpl: (async () => statusResponse(204)) as never,
      log,
    });

    expect(outcome).toBe("stale");
    expect(log.mock.calls[0][0]).toContain("::warning::");
    expect(log.mock.calls[0][0]).toContain("15");
  });

  it("queries the feed for the previous version", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(200));
    const outcome = await checkUpdateFeed({
      releases,
      tag: "v0.2.1",
      fetchImpl: fetchImpl as never,
      log: () => {},
    });

    expect(outcome).toBe("offered");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://update.electronjs.org/davidpoxon/roubo/darwin-arm64/0.2.0",
    );
  });

  it("skips when there is no previous published release", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(200));
    const outcome = await checkUpdateFeed({
      releases: [{ tag_name: "v0.1.0", draft: false, prerelease: false }],
      tag: "v0.1.0",
      fetchImpl: fetchImpl as never,
      log: () => {},
    });

    expect(outcome).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("warns rather than throwing when the feed is unreachable", async () => {
    const log = vi.fn();
    const outcome = await checkUpdateFeed({
      releases,
      tag: "v0.2.1",
      fetchImpl: (async () => {
        throw new Error("ETIMEDOUT");
      }) as never,
      log,
    });

    expect(outcome).toBe("unknown");
    expect(log.mock.calls[0][0]).toContain("::warning::");
  });
});
