// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PendingBenchCard from "./PendingBenchCard";

describe("PendingBenchCard", () => {
  it("renders bench position", () => {
    render(<PendingBenchCard position={3} externalId="org/repo#42" issueTitle="Fix the bug" />);
    expect(screen.getByText("Bench 3")).toBeInTheDocument();
  });

  it("renders the issue number with # prefix", () => {
    render(<PendingBenchCard position={1} externalId="org/repo#99" issueTitle="Fix the bug" />);
    expect(screen.getByText("#99")).toBeInTheDocument();
  });

  it("renders the alert category-number id with # prefix", () => {
    render(
      <PendingBenchCard
        position={1}
        externalId="org/repo#code-scanning-117"
        issueTitle="SQL injection"
      />,
    );
    expect(screen.getByText("#code-scanning-117")).toBeInTheDocument();
  });

  it("renders issue title", () => {
    render(
      <PendingBenchCard position={1} externalId="org/repo#42" issueTitle="Implement dark mode" />,
    );
    expect(screen.getByText("Implement dark mode")).toBeInTheDocument();
  });

  it("shows Setting up... indicator", () => {
    render(<PendingBenchCard position={1} externalId="1" issueTitle="x" />);
    expect(screen.getByText("Setting up...")).toBeInTheDocument();
  });
});
