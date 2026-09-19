// @vitest-environment jsdom
//
// IP-WU-036 / IP-TC-099: zero serious axe violations on the issues-list
// `security-category` chip variant across all three SecurityCategory values.
// #1296: every chip tone, static and pressable, in both themes.

import { afterEach, describe, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Bug } from "lucide-react";
import type { SecurityCategory, StatusTone } from "../lib/chip-mapping";
import IssueChip from "./IssueChip";
import { expectNoAxeFindings } from "../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../test/themes";

const CATEGORIES: { value: SecurityCategory; label: string }[] = [
  { value: "codeql", label: "CodeQL" },
  { value: "secret-scanning", label: "Secret scanning" },
  { value: "dependabot", label: "Dependabot" },
];

const STATUS_TONES: StatusTone[] = ["open", "in-progress", "blocked", "done", "neutral", "warning"];

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("IssueChip security-category: axe-core (IP-WU-036)", () => {
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

describe("IssueChip: axe-core in both themes (#1296)", () => {
  for (const theme of THEMES) {
    it(`has no axe findings on every tone in ${theme}`, async () => {
      const { container } = renderInTheme(
        <div>
          {STATUS_TONES.map((tone) => (
            <IssueChip key={tone} variant="status" tone={tone}>
              {tone}
            </IssueChip>
          ))}
          <IssueChip variant="milestone">v1.2</IssueChip>
          <IssueChip variant="label">bug</IssueChip>
          <IssueChip variant="issue-type" icon={Bug}>
            Bug
          </IssueChip>
          <IssueChip variant="metadata">+3 more</IssueChip>
          <IssueChip variant="status" tone="warning" onPress={() => {}}>
            Unavailable
          </IssueChip>
          <IssueChip variant="milestone" tooltip="Due in 3 days">
            v1.3
          </IssueChip>
        </div>,
        theme,
      );
      expectNoAxeFindings(await axe(container));
    });
  }
});
