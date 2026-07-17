// @vitest-environment jsdom
//
// WU-036 / TC-099: zero serious axe violations on the Test Connection
// per-category result rows. Renders each `CategoryRow` status variant inside
// a `<ul>` (the parent ResultStrip renders an unordered list, so the row's
// `<li>` is wrapped accordingly here to keep axe happy).

import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import type {
  IntegrationCategoryId,
  IntegrationCategoryReport,
  IntegrationCategoryStatus,
} from "@roubo/shared";
import { CategoryRow } from "./PluginConfigureDialog";
import { expectNoAxeFindings } from "../test/axe";

const CATEGORIES: { category: IntegrationCategoryId; label: string }[] = [
  { category: "issues", label: "Issues" },
  { category: "code-scanning", label: "Code Scanning" },
  { category: "secret-scanning", label: "Secret Scanning" },
  { category: "dependabot", label: "Dependabot" },
];

const STATUSES: { status: IntegrationCategoryStatus; detail?: string }[] = [
  { status: "ok" },
  { status: "scope-missing", detail: "Token missing `security_events` scope." },
  { status: "not-enabled", detail: "Not enabled on this repo." },
  { status: "timed-out", detail: "Probe exceeded the 5s per-category cap." },
  { status: "error", detail: "GitHub returned HTTP 502." },
];

describe("PluginConfigureDialog CategoryRow: axe-core (WU-036)", () => {
  for (const { category, label } of CATEGORIES) {
    for (const { status, detail } of STATUSES) {
      it(`has no axe violations for ${category} / ${status}`, async () => {
        const report: IntegrationCategoryReport = { category, label, status, detail };
        const { container } = render(
          <ul>
            <CategoryRow category={report} />
          </ul>,
        );
        const results = await axe(container);
        expectNoAxeFindings(results);
      });
    }
  }
});
