// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createRef } from "react";
import { EditorView } from "@codemirror/view";
import SetupYamlEditor, { type SetupYamlEditorRef } from "./SetupYamlEditor";

vi.mock("./yamlEditorTheme", () => ({
  yamlLightTheme: [],
  yamlDarkTheme: [],
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const MULTI_LINE =
  "project:\n  name: nova\nbenches:\n  max: 3\ncomponents:\n  backend:\n    image: node\n";

describe("SetupYamlEditor", () => {
  it("renders the editor container", () => {
    render(<SetupYamlEditor value="" onChange={() => {}} />);
    expect(screen.getByTestId("setup-yaml-editor")).toBeInTheDocument();
  });

  it("exposes a focus method that does not throw", () => {
    const ref = createRef<SetupYamlEditorRef>();
    render(<SetupYamlEditor ref={ref} value="" onChange={() => {}} />);
    expect(() => ref.current?.focus()).not.toThrow();
  });

  it("exposes a format method that does not throw on valid YAML", () => {
    const ref = createRef<SetupYamlEditorRef>();
    render(<SetupYamlEditor ref={ref} value="project:\n  name: nova\n" onChange={() => {}} />);
    expect(() =>
      act(() => {
        ref.current?.format();
      }),
    ).not.toThrow();
  });

  it("format is a no-op when YAML is invalid", () => {
    const onChange = vi.fn();
    const ref = createRef<SetupYamlEditorRef>();
    render(<SetupYamlEditor ref={ref} value="{ bad: yaml: :" onChange={onChange} />);
    act(() => {
      ref.current?.format();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("scrollToLine dispatches a transaction with selection and scrollIntoView effect", () => {
    const spy = vi.spyOn(EditorView.prototype, "dispatch");
    const ref = createRef<SetupYamlEditorRef>();
    render(<SetupYamlEditor ref={ref} value={MULTI_LINE} onChange={() => {}} />);
    spy.mockClear();
    act(() => {
      ref.current?.scrollToLine(3);
    });
    expect(spy).toHaveBeenCalled();
    const lastSpec = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastSpec).toHaveProperty("selection");
    expect(lastSpec).toHaveProperty("effects");
  });

  it("scrollToLine clamps line 0 to line 1 without throwing", () => {
    const spy = vi.spyOn(EditorView.prototype, "dispatch");
    const ref = createRef<SetupYamlEditorRef>();
    render(<SetupYamlEditor ref={ref} value={MULTI_LINE} onChange={() => {}} />);
    spy.mockClear();
    expect(() =>
      act(() => {
        ref.current?.scrollToLine(0);
      }),
    ).not.toThrow();
    const lastSpec = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastSpec).toHaveProperty("selection");
  });

  it("scrollToLine clamps a beyond-end line without throwing", () => {
    const spy = vi.spyOn(EditorView.prototype, "dispatch");
    const ref = createRef<SetupYamlEditorRef>();
    render(<SetupYamlEditor ref={ref} value={MULTI_LINE} onChange={() => {}} />);
    spy.mockClear();
    expect(() =>
      act(() => {
        ref.current?.scrollToLine(9999);
      }),
    ).not.toThrow();
    const lastSpec = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastSpec).toHaveProperty("selection");
  });
});
