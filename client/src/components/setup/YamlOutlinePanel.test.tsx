// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import YamlOutlinePanel from "./YamlOutlinePanel";

describe("YamlOutlinePanel", () => {
  it("renders scalar key-value pairs", () => {
    const yaml = `project:\n  name: nova\nbenches:\n  max: 3\n`;
    render(<YamlOutlinePanel rawYaml={yaml} />);
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("benches")).toBeInTheDocument();
  });

  it("renders collection count for object values", () => {
    const yaml = `components:\n  backend:\n    image: node\n  frontend:\n    image: vite\n`;
    render(<YamlOutlinePanel rawYaml={yaml} />);
    expect(screen.getByText("components")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders collection count for array values", () => {
    const yaml = `tools:\n  - claude-code\n  - docker\n`;
    render(<YamlOutlinePanel rawYaml={yaml} />);
    expect(screen.getByText("tools")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders extra keys after known keys", () => {
    const yaml = `project:\n  name: nova\nmy_custom_key: value\n`;
    render(<YamlOutlinePanel rawYaml={yaml} />);
    expect(screen.getByText("my_custom_key")).toBeInTheDocument();
  });

  it("renders fallback message when YAML is invalid", () => {
    render(<YamlOutlinePanel rawYaml="{ invalid: yaml: : bad" />);
    expect(screen.getByText(/yaml unreadable/i)).toBeInTheDocument();
  });

  it("renders empty document message for empty input", () => {
    render(<YamlOutlinePanel rawYaml="" />);
    expect(screen.getByText(/empty document/i)).toBeInTheDocument();
  });

  it("clicking the first key calls onSectionClick with key and line 1", () => {
    const spy = vi.fn();
    const yaml = `project:\n  name: nova\nbenches:\n  max: 3\n`;
    render(<YamlOutlinePanel rawYaml={yaml} onSectionClick={spy} />);
    fireEvent.click(screen.getByRole("button", { name: /project/ }));
    expect(spy).toHaveBeenCalledWith("project", 1);
  });

  it("clicking a later known key calls onSectionClick with the correct line", () => {
    const spy = vi.fn();
    const yaml = `project:\n  name: nova\nbenches:\n  max: 3\ncomponents:\n  backend:\n    image: node\n`;
    render(<YamlOutlinePanel rawYaml={yaml} onSectionClick={spy} />);
    fireEvent.click(screen.getByRole("button", { name: /components/ }));
    expect(spy).toHaveBeenCalledWith("components", 5);
  });

  it("clicking an extra key calls onSectionClick with the correct line", () => {
    const spy = vi.fn();
    const yaml = `project:\n  name: nova\nmy_custom_key: value\n`;
    render(<YamlOutlinePanel rawYaml={yaml} onSectionClick={spy} />);
    fireEvent.click(screen.getByRole("button", { name: /my_custom_key/ }));
    expect(spy).toHaveBeenCalledWith("my_custom_key", 3);
  });

  it("uses CST positions so a comment that looks like a key does not affect line resolution", () => {
    // The old string-heuristic would match "# components:" at line 1 as the
    // "components" key because it starts with "components:". CST parsing skips
    // comments and returns the real key's line.
    const spy = vi.fn();
    const yaml = `# components:\nproject:\n  name: nova\ncomponents:\n  backend:\n    image: node\n`;
    render(<YamlOutlinePanel rawYaml={yaml} onSectionClick={spy} />);
    fireEvent.click(screen.getByRole("button", { name: /^components/ }));
    expect(spy).toHaveBeenCalledWith("components", 4);
  });
});
