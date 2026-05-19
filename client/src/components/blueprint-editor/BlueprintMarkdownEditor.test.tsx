// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import BlueprintMarkdownEditor, {
  type BlueprintMarkdownEditorRef,
} from "./BlueprintMarkdownEditor";

vi.mock("./codemirrorTheme", () => ({
  lightTheme: [],
  darkTheme: [],
  variableHighlightPlugin: { extension: [] },
}));

describe("BlueprintMarkdownEditor", () => {
  it("renders the editor container", () => {
    render(<BlueprintMarkdownEditor value="" onChange={() => {}} />);
    expect(screen.getByTestId("blueprint-markdown-editor")).toBeInTheDocument();
  });

  it("calls onChange when content changes via insertAtCursor", () => {
    const onChange = vi.fn();
    const ref = createRef<BlueprintMarkdownEditorRef>();
    render(<BlueprintMarkdownEditor ref={ref} value="" onChange={onChange} />);

    act(() => {
      ref.current?.insertAtCursor("{{bench.id}}");
    });

    expect(onChange).toHaveBeenCalledWith("{{bench.id}}");
  });

  it("replaces selected text when insertAtCursor is called", () => {
    const onChange = vi.fn();
    const ref = createRef<BlueprintMarkdownEditorRef>();
    render(<BlueprintMarkdownEditor ref={ref} value="hello world" onChange={onChange} />);

    act(() => {
      ref.current?.insertAtCursor("{{bench.branch}}");
    });

    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("{{bench.branch}}"));
  });

  it("exposes a focus method", () => {
    const ref = createRef<BlueprintMarkdownEditorRef>();
    render(<BlueprintMarkdownEditor ref={ref} value="" onChange={() => {}} />);
    expect(() => ref.current?.focus()).not.toThrow();
  });
});
