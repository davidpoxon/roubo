import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSourceCandidates } from "../source-picker.js";
import { installHostHarness, type HostHarness } from "./helpers/host-stub.js";

describe("listSourceCandidates", () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = installHostHarness();
  });
  afterEach(() => harness.dispose());

  it("returns the categorized-multi-list shape with Boards, Epics, Filters", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board/1/configuration", () => ({
      filter: { id: 999 },
    }));
    harness.fetchStub.on("/rest/agile/1.0/board", () => ({
      values: [{ id: 1, name: "PROJ Board" }],
    }));
    harness.fetchStub.on("/rest/api/2/search", () => ({
      issues: [{ key: "PROJ-100", fields: { summary: "Platform Q2" } }],
    }));
    harness.fetchStub.on("/rest/api/2/filter/favourite", () => ({
      values: [{ id: 456, name: "My open issues" }],
    }));

    const response = await listSourceCandidates({
      instance: "https://jira.acme.example",
      pat: "tok",
    });

    expect(response.shape).toBe("categorized-multi-list");
    expect(response.categories.map((c) => c.id)).toEqual(["boards", "epics", "filters"]);
    expect(response.categories[0].items).toEqual([
      { externalId: "999", label: "PROJ Board", icon: "board" },
    ]);
    expect(response.categories[1].items[0]).toMatchObject({
      externalId: "PROJ-100",
      label: "Platform Q2",
      icon: "epic",
    });
    expect(response.categories[2].items).toEqual([
      { externalId: "456", label: "My open issues", sublabel: undefined, icon: "filter" },
    ]);
  });

  it("surfaces partial results when one endpoint fails", async () => {
    harness.fetchStub.on("/rest/agile/1.0/board", () => ({ values: [] }));
    harness.fetchStub.on("/rest/api/2/search", () => {
      throw new Error("forbidden");
    });
    harness.fetchStub.on("/rest/api/2/filter/favourite", () => ({
      values: [{ id: 1, name: "Saved" }],
    }));

    const response = await listSourceCandidates({
      instance: "https://jira.acme.example",
      pat: "tok",
    });
    expect(response.categories[1].items).toEqual([]);
    expect(response.categories[2].items).toHaveLength(1);
  });
});
