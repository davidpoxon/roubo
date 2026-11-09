// @vitest-environment jsdom
// The Steering panel of the decisions view (#1622): the composer and the
// boundary it applies at, then the next-boundary line, then the notes, with a
// meta that counts the notes by state.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import {
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  type DeliveryControl,
} from "@roubo/shared/delivery-control-contract";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord, unitEvent } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import BoundaryPanel from "./BoundaryPanel";

function note(controlSeq: number, text: string, status: string): DeliveryControl {
  return {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    control_seq: controlSeq,
    kind: "steering-note",
    body: { note: text, unit_ids: [], applies_at: "B" },
    durability: "durable",
    issued_at: "2026-10-16T10:20:00Z",
    status,
  } as DeliveryControl;
}

function readBack(seq: number, controlSeq: number, text: string): DeliveryEvent {
  return unitEvent(
    seq,
    "B",
    "steering.added",
    {
      steering_id: `steering-${String(controlSeq)}`,
      note: text,
      unit_ids: [],
      control_seq: controlSeq,
    },
    "2026-10-16T10:30:00Z",
  );
}

function renderPanel(events: DeliveryEvent[], controls: DeliveryControl[]) {
  // A is done and B runs, so the next boundary is B finishing.
  const base = fourUnitRecord();
  const record = {
    ...base,
    units: base.units.map((unit) =>
      unit.id === "A"
        ? { ...unit, status: "done" }
        : unit.id === "B"
          ? { ...unit, status: "running" }
          : unit,
    ),
  };
  return renderWithProviders(
    <BoundaryPanel
      projectId="demo"
      benchId={3}
      snapshot={foldDelivery({ record, events, controls })}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("BoundaryPanel", () => {
  it("shows the composer, then the next boundary, then the notes, and counts the notes by state", () => {
    renderPanel(
      [readBack(8, 2, "Will keep it short.")],
      [
        note(1, "Name the cache file by unit.", "pending"),
        note(2, "Keep it short.", "applied"),
        note(3, "Drop the extra layer.", "rejected"),
      ],
    );
    const panel = screen.getByRole("region", { name: "Steering" });
    expect(panel.querySelector("header")).toHaveTextContent("1 queued · 1 applied · 1 rejected");

    // The composer names the boundary its note applies at.
    const composer = within(panel).getByTestId("steering-composer");
    expect(within(composer).getByRole("textbox", { name: "Steering note" })).toBeInTheDocument();
    expect(within(composer).getByTestId("steering-applies-at")).toHaveTextContent(
      "next boundary · B",
    );

    // The next-boundary line and its queue follow the composer, and the settled
    // notes close the panel.
    const boundary = within(panel).getByRole("region", { name: "Next boundary" });
    expect(within(boundary).getByTestId("boundary-name")).toHaveTextContent("B finishes");
    const settled = within(panel).getByRole("list", { name: "Steering notes read back" });
    expect(composer.compareDocumentPosition(boundary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(boundary.compareDocumentPosition(settled)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    expect(within(boundary).getByTestId("steering-note-1")).toHaveAttribute("data-state", "queued");
    expect(within(settled).getByTestId("steering-note-2")).toHaveTextContent(
      "Read-back: Will keep it short.",
    );
    expect(within(settled).getByTestId("steering-note-3")).toHaveAttribute(
      "data-state",
      "rejected",
    );
  });

  it("leaves out a rejected count when no note was rejected", () => {
    renderPanel([], []);
    const panel = screen.getByRole("region", { name: "Steering" });
    expect(panel.querySelector("header")).toHaveTextContent(/^Steering0 queued · 0 applied$/);
    expect(within(panel).getByTestId("boundary-queue-empty")).toBeInTheDocument();
  });
});
