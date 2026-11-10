// @vitest-environment jsdom
//
// The Role matrix row's two menus (SB-FR-021, #1615): the model and the effort,
// saved together as one role change, with the pending badge naming both until
// the read-back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeliveryControl } from "@roubo/shared/delivery-control-contract";
import {
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
} from "@roubo/shared/delivery-control-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, changeDeliveryRole: vi.fn() };
});
import * as api from "../../lib/api";
import RoleMatrix from "./RoleMatrix";

function roleChange(body: Record<string, unknown>): DeliveryControl {
  return {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    control_seq: 1,
    kind: "role-change",
    target_id: "unit-coder",
    body,
    durability: "durable",
    issued_at: "2026-10-16T10:00:00Z",
    status: "pending",
  } as unknown as DeliveryControl;
}

function renderMatrix(controls: DeliveryControl[] = []) {
  const record = fourUnitRecord();
  record.roles = {
    main: { tier: "balanced", effort: "medium" },
    "unit-coder": { tier: "fast" },
  };
  renderWithProviders(
    <RoleMatrix
      projectId="demo"
      benchId={3}
      snapshot={foldDelivery({ record, events: [], controls })}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(api.changeDeliveryRole).mockReset();
});

describe("RoleMatrix", () => {
  it("shows each role's effort beside its model, and a placeholder for a role the record names no effort for", () => {
    renderMatrix();
    expect(screen.getByRole("combobox", { name: "Effort of main" })).toHaveValue("medium");
    const coderEffort = screen.getByRole("combobox", { name: "Effort of unit-coder" });
    expect(coderEffort).toHaveValue("");
    expect(
      within(coderEffort)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["no effort", "low", "medium", "high", "xhigh", "max"]);
    expect(
      screen.getByRole("button", { name: "Save the model and effort of unit-coder" }),
    ).toBeDisabled();
  });

  it("saves a changed effort alone with the tier in effect, and a model change without an effort the record lacks", async () => {
    vi.mocked(api.changeDeliveryRole).mockResolvedValue(roleChange({}) as never);
    const user = userEvent.setup();
    renderMatrix();

    await user.selectOptions(screen.getByRole("combobox", { name: "Effort of main" }), "max");
    await user.click(screen.getByRole("button", { name: "Save the model and effort of main" }));
    await waitFor(() =>
      expect(api.changeDeliveryRole).toHaveBeenCalledWith("demo", 3, "main", "balanced", "max"),
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model of unit-coder" }),
      "large",
    );
    await user.click(
      screen.getByRole("button", { name: "Save the model and effort of unit-coder" }),
    );
    await waitFor(() =>
      expect(api.changeDeliveryRole).toHaveBeenLastCalledWith(
        "demo",
        3,
        "unit-coder",
        "large",
        undefined,
      ),
    );
  });

  it("names the pending model and effort in the badge, and only the model when the change names no effort", () => {
    renderMatrix([roleChange({ tier: "large", effort: "high" })]);
    expect(screen.getByTestId("role-pending-unit-coder")).toHaveTextContent(
      "pending · large · high · next boundary",
    );
    cleanup();
    renderMatrix([roleChange({ tier: "large" })]);
    expect(screen.getByTestId("role-pending-unit-coder")).toHaveTextContent(
      "pending · large · next boundary",
    );
  });
});
