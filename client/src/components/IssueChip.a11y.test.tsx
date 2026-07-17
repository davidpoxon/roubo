// @vitest-environment jsdom
//
// WU-036 / TC-099: zero serious axe violations on the issues-list
// `security-category` chip variant across all three SecurityCategory values.

import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import type { SecurityCategory } from "../lib/chip-mapping";
import IssueChip from "./IssueChip";
import { expectNoAxeFindings } from "../test/axe";

const CATEGORIES: { value: SecurityCategory; label: string }[] = [
  { value: "codeql", label: "CodeQL" },
  { value: "secret-scanning", label: "Secret scanning" },
  { value: "dependabot", label: "Dependabot" },
];

describe("IssueChip security-category: axe-core (WU-036)", () => {
  for (const { value, label } of CATEGORIES) {
    it(`has no axe violations on the ${value} variant`, async () => {
      const { container } = render(
        <IssueChip variant="security-category" securityCategory={value}>
          {label}
        </IssueChip>,
      );
      const results = await axe(container);
      expectNoAxeFindings(results);
    });

    it(`has no axe violations on the ${value} variant with a tooltip`, async () => {
      const { container } = render(
        <IssueChip
          variant="security-category"
          securityCategory={value}
          tooltip="High severity"
          ariaDescription={`${label} alert: high severity`}
        >
          {label}
        </IssueChip>,
      );
      const results = await axe(container);
      expectNoAxeFindings(results);
    });
  }
});
