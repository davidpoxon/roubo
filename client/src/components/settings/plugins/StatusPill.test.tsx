// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { PluginStatus } from "@roubo/shared";
import StatusPill from "./StatusPill";

const cases: { status: PluginStatus; label: string; tint: string }[] = [
  { status: "enabled", label: "Enabled", tint: "success" },
  { status: "disabled", label: "Disabled", tint: "bg-hover" },
  { status: "errored", label: "Errored", tint: "danger" },
  { status: "incompatible", label: "Incompatible", tint: "accent" },
  { status: "invalid", label: "Invalid", tint: "danger" },
];

describe("StatusPill (TC-001, TC-002, TC-003, TC-013)", () => {
  for (const { status, label, tint } of cases) {
    it(`renders ${status} with label "${label}" and ${tint} tint`, () => {
      const { getByTestId } = render(<StatusPill status={status} />);
      const pill = getByTestId("plugin-status-pill");
      expect(pill.dataset.status).toBe(status);
      expect(pill.textContent).toContain(label);
      expect(pill.className).toContain(tint);
    });
  }
});
