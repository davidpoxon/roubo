// @vitest-environment jsdom
//
// WU-036 / TC-099: zero serious axe violations on IssueAssignControl in its
// enabled, disabled-with-tooltip, and disabled-bare states. The disabled
// variant is the WU-033 "alert-backed bench" affordance.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapturedUserId } from "@roubo/shared";
import IssueAssignControl from "./IssueAssignControl";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    assignIssueToUser: vi.fn(),
    unassignIssueFromUser: vi.fn(),
  };
});

const jane: CapturedUserId = { externalId: "jane@acme.com", displayName: "Jane Doe" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IssueAssignControl: axe-core (WU-036)", () => {
  it("has no axe violations in the enabled state", async () => {
    const { container } = renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-1"
        assignees={[]}
        capturedUserId={jane}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in the assigned state", async () => {
    const { container } = renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-1"
        assignees={[{ externalId: "jane@acme.com", displayName: "Jane Doe" }]}
        capturedUserId={jane}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in the disabled state with a documented tooltip", async () => {
    const { container } = renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-1"
        assignees={[]}
        capturedUserId={jane}
        isDisabled
        disabledTooltip="Alert-backed benches cannot be assigned through Roubo."
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in the disabled state without a tooltip", async () => {
    const { container } = renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-1"
        assignees={[]}
        capturedUserId={jane}
        isDisabled
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
