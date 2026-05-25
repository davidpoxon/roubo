/**
 * WU-038: GHE plugin listIssues alert-merge behaviour.
 *
 * Covers TC-136 (alerts in cut list with distinct issue-type chip) and FR-075:
 * - All booleans off → no alert fetches dispatched
 * - All booleans on, healthy → mapped alerts merged in fixed order (issues →
 *   code-scanning → secret-scanning → dependabot), no warnings
 * - Code-scanning 404 → warning emitted, other two categories proceed
 * - Page > 1 → no alert fetches even with booleans on
 * - Project source spanning two repos → warnings deduped by (category, cause)
 * - allowSelfSignedTls flag on active config → forwarded on every alert
 *   host.fetch call (GHE-specific; self-signed instances must stay reachable)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource, FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { setActiveConfig } from "../active-config.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

interface InstalledMocks {
  mockHost: ReturnType<typeof installMocks>["mockHost"];
  mockOctokit: ReturnType<typeof installMocks>["mockOctokit"];
}

let mocks: InstalledMocks;

const CODE_URL =
  "https://ghe.example.com/api/v3/repos/foo/bar/code-scanning/alerts?state=open&per_page=50&page=1";
const SECRET_URL =
  "https://ghe.example.com/api/v3/repos/foo/bar/secret-scanning/alerts?state=open&per_page=50&page=1";
const DEP_URL =
  "https://ghe.example.com/api/v3/repos/foo/bar/dependabot/alerts?state=open&per_page=50&page=1";

function queueHostResponses(map: Record<string, FetchResult>) {
  mocks.mockHost.fetch.mockImplementation(async (url: string, _init?: FetchInit) => {
    const r = map[url];
    if (!r) throw new Error(`unexpected url ${url}`);
    return r;
  });
}

beforeEach(() => {
  resetAlertsRuntime();
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
  resetAlertsRuntime();
});

function queueIssuesPage(items: unknown[] = []) {
  mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(items));
  mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });
}

describe("listIssues + alerts (WU-038, GHE)", () => {
  it("does not dispatch alert fetches when no booleans are enabled", async () => {
    queueIssuesPage();
    const sources: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });
    expect(result.items).toEqual([]);
    expect(result.warnings).toBeUndefined();
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("merges all three categories in fixed order with no warnings when healthy", async () => {
    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 7, html_url: "code-url", state: "open", created_at: "t" }]),
      },
      [SECRET_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([
          { number: 9, html_url: "secret-url", state: "open", created_at: "t" },
        ]),
      },
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 3, html_url: "dep-url", state: "open", created_at: "t" }]),
      },
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.warnings).toBeUndefined();
    expect(result.items.map((i) => i.externalId)).toEqual([
      "foo/bar#code-scanning-7",
      "foo/bar#secret-scanning-9",
      "foo/bar#dependabot-3",
    ]);
    expect(result.items.map((i) => i.issueType)).toEqual([
      "security-code-scanning",
      "security-secret-scanning",
      "security-dependabot",
    ]);
    expect(result.items.map((i) => i.integrationId)).toEqual(["ghe", "ghe", "ghe"]);
    expect(result.items.map((i) => i.allowedTransitions)).toEqual([[], [], []]);
  });

  it("emits a warning for the failing category and continues fetching the others", async () => {
    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: { status: 404, headers: {}, body: "" },
      [SECRET_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 1, html_url: "u", state: "open", created_at: "t" }]),
      },
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual(["foo/bar#dependabot-1"]);
    expect(result.warnings).toEqual([
      {
        category: "code-scanning",
        sourceExternalId: "foo/bar",
        cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
        detail: { status: 404 },
      },
    ]);
  });

  it("does not dispatch alert fetches on page 2+", async () => {
    queueIssuesPage();
    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: "2", pageSize: 50 });
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("dedupes project warnings by (category, cause) across repos in the project", async () => {
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: {
        projectV2: {
          title: "P",
          items: {
            nodes: [
              {
                content: {
                  __typename: "Issue",
                  number: 1,
                  title: "a",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/repo1" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u1",
                },
                fieldValueByName: null,
              },
              {
                content: {
                  __typename: "Issue",
                  number: 2,
                  title: "b",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/repo2" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u2",
                },
                fieldValueByName: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const CODE_URL_1 =
      "https://ghe.example.com/api/v3/repos/foo/repo1/code-scanning/alerts?state=open&per_page=50&page=1";
    const CODE_URL_2 =
      "https://ghe.example.com/api/v3/repos/foo/repo2/code-scanning/alerts?state=open&per_page=50&page=1";

    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      if (url === CODE_URL_1 || url === CODE_URL_2) {
        return { status: 404, headers: {}, body: "" };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "project",
        externalId: "foo/#1",
        includeCodeQLAlerts: true,
      },
    ];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.warnings).toEqual([
      {
        category: "code-scanning",
        sourceExternalId: "foo/#1",
        cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
        detail: { status: 404 },
      },
    ]);
  });

  it("forwards allowSelfSignedTls on every alert host.fetch when the active config opts in", async () => {
    // Override the default helpers config (allowSelfSignedTls: false) so the
    // transport's per-call resolver picks up the TLS flag.
    setActiveConfig({ instance: "https://ghe.example.com", allowSelfSignedTls: true });

    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
      [SECRET_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
      [DEP_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: null, pageSize: 50 });

    const alertCalls = mocks.mockHost.fetch.mock.calls.filter(
      ([url]) => url === CODE_URL || url === SECRET_URL || url === DEP_URL,
    );
    expect(alertCalls.length).toBe(3);
    for (const [, init] of alertCalls) {
      expect(init?.allowSelfSignedTls).toBe(true);
    }
  });
});
