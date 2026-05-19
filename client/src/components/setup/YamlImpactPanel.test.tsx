// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import YamlImpactPanel from "./YamlImpactPanel";
import type { ImpactResult } from "./computeImpact";

const NO_CHANGE_IMPACT: ImpactResult = {
  changed: false,
  affected: [],
  unaffectedActive: [],
  idleCount: 2,
};

const WITH_CHANGES_IMPACT: ImpactResult = {
  changed: true,
  affected: [{ id: 1, displayName: "feat-auth", reasons: ["components.backend changed"] }],
  unaffectedActive: [{ id: 2, displayName: "feat-ui" }],
  idleCount: 1,
};

describe("YamlImpactPanel", () => {
  it("renders advisory copy when no changes", () => {
    render(<YamlImpactPanel impact={NO_CHANGE_IMPACT} />);
    expect(screen.getByText(/Saving will reload/)).toBeInTheDocument();
  });

  it("renders tally line with active + idle counts", () => {
    render(<YamlImpactPanel impact={WITH_CHANGES_IMPACT} totalBenches={3} />);
    expect(screen.getByText(/active/)).toBeInTheDocument();
    expect(screen.getByText(/idle/)).toBeInTheDocument();
  });

  it("renders affected bench name when config changes", () => {
    render(<YamlImpactPanel impact={WITH_CHANGES_IMPACT} />);
    expect(screen.getByText("feat-auth")).toBeInTheDocument();
  });

  it("renders reason for affected bench", () => {
    render(<YamlImpactPanel impact={WITH_CHANGES_IMPACT} />);
    expect(screen.getByText(/components\.backend changed/)).toBeInTheDocument();
  });

  it("renders null impact gracefully", () => {
    render(<YamlImpactPanel impact={null} totalBenches={5} />);
    expect(screen.getByText(/Saving will reload/)).toBeInTheDocument();
  });
});
