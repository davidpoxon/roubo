// The delivery-decision notification raised from accepted events (SB-FR-014,
// SB-FR-034).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";

vi.mock("./notification.js", () => ({
  createNotification: vi.fn(),
  dismissByKey: vi.fn(() => false),
}));

import * as notification from "./notification.js";
import { makeBench } from "../test/fixtures.js";
import { applyDeliveryDecisionNotifications } from "./delivery-decision.js";

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type,
    seq,
    ts: "2026-10-16T10:00:00Z",
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

function raised(seq: number, decisionId: string, unitId?: string): DeliveryEvent {
  return event(
    seq,
    "decision.raised",
    {
      decision_id: decisionId,
      question: `Question of ${decisionId}?`,
      options: ["one", "two"],
      default: "one",
    },
    unitId,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyDeliveryDecisionNotifications", () => {
  it("SB-TC-036: raises a delivery-decision keyed by the decision id for each raised decision", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      raised(8, "decision-1", "A"),
      raised(9, "decision-2"),
    ]);
    expect(vi.mocked(notification.createNotification).mock.calls).toEqual([
      [
        bench,
        "delivery-decision",
        undefined,
        { decisionId: "decision-1", question: "Question of decision-1?", unitId: "A" },
        undefined,
        undefined,
        "decision-1",
      ],
      [
        bench,
        "delivery-decision",
        undefined,
        { decisionId: "decision-2", question: "Question of decision-2?" },
        undefined,
        undefined,
        "decision-2",
      ],
    ]);
    expect(notification.dismissByKey).not.toHaveBeenCalled();
  });

  it("dismisses the decision's notification on an answer or an overturn, and keeps it on a default", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      event(10, "decision.answered", { decision_id: "decision-1", answer: "one" }),
      event(11, "decision.overturned", { id: "decision-2", option: "two" }),
      event(12, "decision.defaulted", { decision_id: "decision-3" }),
    ]);
    expect(vi.mocked(notification.dismissByKey).mock.calls).toEqual([
      [bench, "delivery-decision", "decision-1"],
      [bench, "delivery-decision", "decision-2"],
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
  });

  it("takes only the last event a batch gives a decision", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      raised(8, "decision-1"),
      event(9, "decision.answered", { decision_id: "decision-1", answer: "one" }),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
    expect(notification.dismissByKey).toHaveBeenCalledTimes(1);
  });

  it("ignores a raise with no decision id or no question, and other event types", () => {
    const bench = makeBench();
    applyDeliveryDecisionNotifications(bench, [
      event(8, "decision.raised", { question: "No id?" }),
      event(9, "decision.raised", { decision_id: "decision-1" }),
      event(10, "decision.answered", {}),
      event(11, "unit.changed", { status: "running" }, "A"),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
    expect(notification.dismissByKey).not.toHaveBeenCalled();
  });
});

describe("applyDeliveryDecisionNotifications: agent decisions and review calls", () => {
  // The fixture record with no decision and nothing to review, in auto mode.
  function autoRecord(): DeliveryRecord {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
        "utf8",
      ),
    );
    const parsed = validateDeliveryRecord(raw);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    return {
      ...parsed.data,
      mode: { value: "auto", pending: null },
      review: { status: "none", unreviewed: [] },
      decisions: [],
    };
  }

  // The session decides a decision on its own, `second` seconds after 10:00.
  function decided(seq: number, decisionId: string, second = 0): DeliveryEvent {
    return event(
      seq,
      "decision.decided",
      {
        decision_id: decisionId,
        question: `Question of ${decisionId}?`,
        options: ["one", "two"],
        default: "one",
        chosen: "two",
        rationale: `<script>alert("${decisionId}")</script>`,
        affected_units: ["B", "C"],
        decided_at: new Date(Date.UTC(2026, 9, 16, 10, 0, second)).toISOString(),
      },
      "B",
    );
  }

  // Applies a batch the way the event route does: the fold covers every
  // accepted event, the earlier batches' included.
  function applyBatch(
    bench: ReturnType<typeof makeBench>,
    before: readonly DeliveryEvent[],
    batch: DeliveryEvent[],
  ): void {
    applyDeliveryDecisionNotifications(bench, batch, () =>
      foldDelivery({ record: autoRecord(), events: [...before, ...batch] }),
    );
  }

  function reviewCalls() {
    return vi.mocked(notification.createNotification).mock.calls;
  }

  it("SB-TC-080: a decision.decided raises no notification, and a decision.raised still raises one", () => {
    const bench = makeBench();
    applyBatch(bench, [], [decided(8, "D-1")]);
    expect(notification.createNotification).not.toHaveBeenCalled();

    applyBatch(bench, [decided(8, "D-1")], [raised(9, "D-9", "B")]);
    expect(reviewCalls()).toEqual([
      [
        bench,
        "delivery-decision",
        undefined,
        { decisionId: "D-9", question: "Question of D-9?", unitId: "B" },
        undefined,
        undefined,
        "D-9",
      ],
    ]);
  });

  it("SB-TC-081: a review.opened raises one notification keyed by delivery, trigger and oldest card, with a count only", () => {
    const bench = makeBench();
    const before = [decided(8, "D-2", 2), decided(9, "D-1", 1), decided(10, "D-3", 3)];
    applyBatch(bench, before, [
      event(11, "review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2", "D-3"] }),
    ]);
    expect(reviewCalls()).toEqual([
      [
        bench,
        "delivery-decision",
        undefined,
        { review: true, count: 3 },
        undefined,
        undefined,
        "review:demo-delivery-1:boundary:D-1",
      ],
    ]);
  });

  it("SB-TC-081: the oldest card is taken by decided_at, not from the order the event lists", () => {
    const bench = makeBench();
    const before = [decided(8, "D-2", 2), decided(9, "D-1", 1), decided(10, "D-3", 3)];
    applyBatch(bench, before, [
      event(11, "review.opened", { trigger: "gate", unreviewed: ["D-3", "D-2", "D-1"] }),
    ]);
    expect(reviewCalls()).toHaveLength(1);
    expect(reviewCalls()[0][3]).toEqual({ review: true, count: 3 });
    expect(reviewCalls()[0][6]).toBe("review:demo-delivery-1:gate:D-1");
  });

  it("SB-TC-081: a review.opened that lists nothing while a decision waits raises one for the folded cards", () => {
    const bench = makeBench();
    applyBatch(
      bench,
      [decided(8, "D-1", 1)],
      [event(9, "review.opened", { trigger: "boundary", unreviewed: [] })],
    );
    expect(reviewCalls()).toEqual([
      [
        bench,
        "delivery-decision",
        undefined,
        { review: true, count: 1 },
        undefined,
        undefined,
        "review:demo-delivery-1:boundary:D-1",
      ],
    ]);
  });

  it("SB-TC-081: a review.opened that lists a reviewed decision counts and keys on the cards still waiting", () => {
    const bench = makeBench();
    const before = [
      decided(8, "D-1", 1),
      decided(9, "D-2", 2),
      event(10, "review.outcome", { decision_id: "D-1", status: "accepted" }),
    ];
    applyBatch(bench, before, [
      event(11, "review.opened", { trigger: "boundary", unreviewed: ["D-1", "D-2"] }),
    ]);
    expect(reviewCalls()).toHaveLength(1);
    expect(reviewCalls()[0][3]).toEqual({ review: true, count: 1 });
    expect(reviewCalls()[0][6]).toBe("review:demo-delivery-1:boundary:D-2");
  });

  it("SB-TC-083: the review notification carries no text the session wrote", () => {
    const bench = makeBench();
    applyBatch(
      bench,
      [decided(8, "D-2", 2)],
      [decided(9, "D-1", 1), event(10, "review.opened", { trigger: "gate" })],
    );
    expect(notification.createNotification).toHaveBeenCalledTimes(1);
    const metadata = reviewCalls()[0][3];
    expect(metadata).toEqual({ review: true, count: 2 });
    expect(JSON.stringify(metadata)).not.toMatch(/script|Question|alert/);
  });

  it("SB-TC-103: a review.opened listing 100 decisions raises one notification with the count 100", () => {
    const bench = makeBench();
    const ids = Array.from({ length: 100 }, (_, index) => `D-${index + 1}`);
    applyBatch(bench, [], [
      ...ids.map((id, index) => decided(8 + index, id, index)),
      event(108, "review.opened", { trigger: "boundary", unreviewed: ids }),
    ]);
    expect(reviewCalls()).toEqual([
      [
        bench,
        "delivery-decision",
        undefined,
        { review: true, count: 100 },
        undefined,
        undefined,
        "review:demo-delivery-1:boundary:D-1",
      ],
    ]);
  });

  it("raises nothing for a review.opened with nothing to review, or with no record to fold", () => {
    const bench = makeBench();
    applyBatch(bench, [], [event(10, "review.opened", { unreviewed: [] })]);
    applyBatch(bench, [], [event(11, "review.opened", { unreviewed: ["D-404"] })]);
    applyDeliveryDecisionNotifications(bench, [
      decided(12, "D-1"),
      event(13, "review.opened", { unreviewed: ["D-1"] }),
    ]);
    expect(notification.createNotification).not.toHaveBeenCalled();
  });
});
