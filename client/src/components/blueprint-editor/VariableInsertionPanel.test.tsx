// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VariableInsertionPanel from "./VariableInsertionPanel";

describe("VariableInsertionPanel", () => {
  it("renders groups in order: Issue, Bench, Project, Config", () => {
    render(<VariableInsertionPanel scope="global" onInsert={() => {}} />);
    const headings = screen.getAllByText(/Issue|Bench|Project|Config/i);
    const labels = headings.map((el) => el.textContent?.trim());
    expect(labels).toContain("Issue");
    expect(labels).toContain("Bench");
    expect(labels).toContain("Project");
    expect(labels).toContain("Config");
    const issueIdx = labels.indexOf("Issue");
    const benchIdx = labels.indexOf("Bench");
    const projectIdx = labels.indexOf("Project");
    const configIdx = labels.indexOf("Config");
    expect(issueIdx).toBeLessThan(benchIdx);
    expect(benchIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(configIdx);
  });

  it("shows config footnote at global scope", () => {
    render(<VariableInsertionPanel scope="global" onInsert={() => {}} />);
    expect(screen.getByText(/Config placeholders are inserted literally/)).toBeInTheDocument();
  });

  it("does not show config footnote at project scope", () => {
    render(<VariableInsertionPanel scope="project" onInsert={() => {}} />);
    expect(
      screen.queryByText(/Config placeholders are inserted literally/),
    ).not.toBeInTheDocument();
  });

  it("calls onInsert with the variable syntax when clicked", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<VariableInsertionPanel scope="global" onInsert={onInsert} />);

    const issueTitle = screen.getByText("{{issueTitle}}");
    await user.click(issueTitle);
    expect(onInsert).toHaveBeenCalledWith("{{issueTitle}}");
  });

  it("inserts literal config placeholder syntax at global scope", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<VariableInsertionPanel scope="global" onInsert={onInsert} />);

    const configVar = screen.getByText("{{ports.<component>}}");
    await user.click(configVar);
    expect(onInsert).toHaveBeenCalledWith("{{ports.<component>}}");
  });
});
