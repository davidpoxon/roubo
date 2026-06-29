// @vitest-environment jsdom
//
// The 4-step install/update progress widget (issue #374, CPHM-TC-017 S002-O01).
// It is purely presentational: given a per-stage status array it renders the
// four labelled stages with the prototype's treatment (numbered badge -> check
// on done, amber active, red cross + fail-closed message on failure) and the
// per-stage meta lines (artifact filename, ed25519, sha256, ~/.roubo/plugins/<id>).

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { InstallErrorCode } from "@roubo/shared";
import type { StageStatus } from "./marketplace-install-stages";
import MarketplaceInstallProgress from "./MarketplaceInstallProgress";

function renderWidget(statuses: StageStatus[], errorCode?: InstallErrorCode) {
  return render(
    <MarketplaceInstallProgress
      statuses={statuses}
      pluginId="ghe"
      artifactLabel="ghe-0.2.0.tgz"
      errorCode={errorCode}
    />,
  );
}

describe("MarketplaceInstallProgress", () => {
  it("renders all four labelled stages with their meta lines (CPHM-TC-017 S002-O01)", () => {
    renderWidget(["active", "active", "active", "pending"]);
    expect(screen.getByTestId("marketplace-install-progress")).toBeInTheDocument();

    const widget = screen.getByTestId("marketplace-install-progress");
    expect(within(widget).getByText("Download built artifact")).toBeInTheDocument();
    expect(within(widget).getByText("Verify catalog signature")).toBeInTheDocument();
    expect(within(widget).getByText("Verify artifact digest")).toBeInTheDocument();
    expect(within(widget).getByText("Unpack & install")).toBeInTheDocument();

    // Per-stage meta lines mirror the prototype.
    expect(within(widget).getByText("ghe-0.2.0.tgz")).toBeInTheDocument();
    expect(within(widget).getByText("ed25519")).toBeInTheDocument();
    expect(within(widget).getByText("sha256")).toBeInTheDocument();
    expect(within(widget).getByText("~/.roubo/plugins/ghe")).toBeInTheDocument();

    // Exactly four steps, each carrying its status on a stable testid.
    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`marketplace-install-step-${i}`)).toBeInTheDocument();
    }
  });

  it("reflects each status on the step's data-status attribute", () => {
    renderWidget(["done", "done", "active", "pending"]);
    expect(screen.getByTestId("marketplace-install-step-0")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("marketplace-install-step-1")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("marketplace-install-step-2")).toHaveAttribute(
      "data-status",
      "active",
    );
    expect(screen.getByTestId("marketplace-install-step-3")).toHaveAttribute(
      "data-status",
      "pending",
    );
  });

  it("shows the numbered badge on pending/active stages", () => {
    renderWidget(["active", "pending", "pending", "pending"]);
    // Pending/active badges carry the 1-based stage number.
    expect(
      within(screen.getByTestId("marketplace-install-step-0")).getByText("1"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("marketplace-install-step-1")).getByText("2"),
    ).toBeInTheDocument();
  });

  it("surfaces a fail-closed message on the failed stage and hides its meta line", () => {
    renderWidget(["done", "done", "failed", "pending"]);
    const failed = screen.getByTestId("marketplace-install-step-2");
    expect(failed).toHaveAttribute("data-status", "failed");
    const failMessage = within(failed).getByTestId("marketplace-install-step-2-error");
    expect(failMessage).toHaveTextContent(/nothing written, nothing executed/i);
    // The meta line (sha256) is replaced by the failure message.
    expect(within(failed).queryByText("sha256")).not.toBeInTheDocument();
    // The numbered badge is gone (a cross is shown instead).
    expect(within(failed).queryByText("3")).not.toBeInTheDocument();
  });

  it("shows a code-accurate failure message: an unpack containment rejection is not a digest mismatch (issue #374 corr-1)", () => {
    renderWidget(["done", "done", "failed", "pending"], "unpack-failed");
    const failed = screen.getByTestId("marketplace-install-step-2");
    const failMessage = within(failed).getByTestId("marketplace-install-step-2-error");
    expect(failMessage).toHaveTextContent(/could not be safely unpacked/i);
    expect(failMessage).not.toHaveTextContent(/digest mismatch/i);
  });

  it("keeps the digest mismatch wording for an integrity failure on the digest stage", () => {
    renderWidget(["done", "done", "failed", "pending"], "integrity-failed");
    const failed = screen.getByTestId("marketplace-install-step-2");
    expect(within(failed).getByTestId("marketplace-install-step-2-error")).toHaveTextContent(
      /digest mismatch/i,
    );
  });

  it("defaults a missing status entry to pending", () => {
    renderWidget(["done"]);
    expect(screen.getByTestId("marketplace-install-step-3")).toHaveAttribute(
      "data-status",
      "pending",
    );
  });
});
