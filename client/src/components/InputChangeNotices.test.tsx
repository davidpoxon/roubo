// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { InputChangedEvent } from "@roubo/shared";
import InputChangeNotices from "./InputChangeNotices";
import {
  INPUT_NOTICE_TIMEOUT_MS,
  LAST_GOOD_LINE,
  inputNoticeText,
  publishInputChanged,
} from "../lib/input-changed";

function applied(overrides?: Partial<InputChangedEvent>): InputChangedEvent {
  return {
    type: "input-changed",
    surface: "project-config",
    outcome: "applied",
    projectId: "p1",
    benchIds: [1, 2],
    summary: "Project config applied to 2 benches",
    ...overrides,
  };
}

function rejected(overrides?: Partial<InputChangedEvent>): InputChangedEvent {
  return {
    type: "input-changed",
    surface: "project-config",
    outcome: "rejected",
    projectId: "p1",
    summary: "Project config rejected",
    error: { path: "roubo.yaml", first: "benches.max: expected a number" },
    ...overrides,
  };
}

function Screen({ onSetUp }: { onSetUp: () => void }) {
  return (
    <div>
      <button type="button" onClick={onSetUp}>
        Set up bench
      </button>
      <InputChangeNotices />
    </div>
  );
}

function notices(): HTMLElement[] {
  return screen.queryAllByRole("status");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InputChangeNotices", () => {
  it("HR-TC-037 a visible applied notice does not block a click on Set up bench and remains after it", () => {
    const onSetUp = vi.fn();
    render(<Screen onSetUp={onSetUp} />);
    act(() => publishInputChanged(applied()));
    expect(screen.getByText("Project config applied to 2 benches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Set up bench" }));

    expect(onSetUp).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Project config applied to 2 benches")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Only the notice itself takes pointer events; its container passes them through.
    const region = screen.getByTestId("input-change-notices");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.className).toContain("pointer-events-none");
    expect(notices()[0].className).toContain("pointer-events-auto");
    expect(document.activeElement).not.toBe(notices()[0]);
  });

  it("HR-TC-037 an applied notice is gone after 8 s", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() => publishInputChanged(applied()));
    act(() => vi.advanceTimersByTime(INPUT_NOTICE_TIMEOUT_MS - 1));
    expect(notices()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(notices()).toHaveLength(0);
    expect(INPUT_NOTICE_TIMEOUT_MS).toBe(8_000);
  });

  it("HR-TC-037 a refused notice is gone after 8 s", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() =>
      publishInputChanged(
        applied({ surface: "plugin", outcome: "refused", summary: "Plugin change refused" }),
      ),
    );
    expect(notices()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(INPUT_NOTICE_TIMEOUT_MS));
    expect(notices()).toHaveLength(0);
  });

  it("HR-TC-037 a rejected notice is still there after 8 s and goes on dismiss", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() => publishInputChanged(rejected()));
    act(() => vi.advanceTimersByTime(INPUT_NOTICE_TIMEOUT_MS * 4));
    expect(notices()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(notices()).toHaveLength(0);
  });

  it("HR-TC-037 a rejected notice is cleared by a later applied change of the same target only", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() => publishInputChanged(rejected()));
    act(() =>
      publishInputChanged(applied({ projectId: "other", summary: "Project other applied" })),
    );
    expect(screen.getByText(/Project config rejected/)).toBeInTheDocument();

    act(() => publishInputChanged(applied()));
    expect(screen.queryByText(/Project config rejected/)).toBeNull();
    expect(screen.getByText("Project config applied to 2 benches")).toBeInTheDocument();
  });

  it("HR-TC-037 a rejected notice the watcher wrote itself, with only the watch's projectId and a generic error, is cleared by the next applied change of that project", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() =>
      publishInputChanged({
        type: "input-changed",
        surface: "project-config",
        outcome: "rejected",
        projectId: "p1",
        summary: "Project change rejected",
        error: { path: "roubo.yaml", first: "the change could not be read or validated" },
      }),
    );
    expect(notices()[0].querySelector("p")?.textContent).toBe(
      "Project change rejected. roubo.yaml: the change could not be read or validated. Last good config is still live.",
    );

    act(() => publishInputChanged(applied()));
    expect(screen.queryByText(/Project change rejected/)).toBeNull();
    expect(screen.getByText("Project config applied to 2 benches")).toBeInTheDocument();
  });

  it("writes each notice as one line that starts with the surface's thing", () => {
    render(<Screen onSetUp={vi.fn()} />);
    const cases: [InputChangedEvent["surface"], string][] = [
      ["project-config", "Project"],
      ["plugin", "Plugin"],
      ["settings", "Settings"],
      ["bench", "Bench"],
      ["github", "GitHub"],
      ["environment", "Environment"],
    ];
    act(() => {
      for (const [surface] of cases) {
        publishInputChanged(applied({ surface, summary: "change applied" }));
      }
    });
    const texts = notices().map((n) => n.querySelector("p")?.textContent ?? "");
    expect(texts).toEqual(cases.map(([, thing]) => `${thing} change applied`));
    for (const text of texts) expect(text).not.toContain("\n");
  });

  it("writes a rejected notice with the path, the first error and the last-good line", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() => publishInputChanged(rejected()));
    expect(notices()[0].querySelector("p")?.textContent).toBe(
      "Project config rejected. roubo.yaml: benches.max: expected a number. Last good config is still live.",
    );
    expect(LAST_GOOD_LINE).toBe("Last good config is still live.");
  });

  it("writes a rejected notice with no error as the summary and the last-good line", () => {
    render(<Screen onSetUp={vi.fn()} />);
    act(() =>
      publishInputChanged(rejected({ summary: "Project config rejected.", error: undefined })),
    );
    expect(notices()[0].querySelector("p")?.textContent).toBe(
      "Project config rejected. Last good config is still live.",
    );
  });

  // The server can send the summary alone, with the path and the first error
  // in `error`; the client then writes the rest of the sentence itself.
  it.each([
    ["with", 'components.web: Unrecognized key: "command".'],
    ["without", 'components.web: Unrecognized key: "command"'],
  ])(
    "HR-TC-004 HR-TC-038 writes the whole rejected roubo.yaml sentence from a bare summary, a first error %s its full stop",
    (_, first) => {
      const text = inputNoticeText(
        rejected({
          projectId: "lantern",
          summary: "Project lantern: roubo.yaml not applied.",
          error: { path: ".roubo/roubo.yaml", first },
        }),
      );
      expect(text).toBe(
        'Project lantern: roubo.yaml not applied. .roubo/roubo.yaml: components.web: Unrecognized key: "command". Last good config is still live.',
      );
      expect(text).not.toContain(".:");
      expect(text).not.toContain("..");
    },
  );

  it("HR-TC-004 HR-TC-038 renders the server's whole rejected roubo.yaml sentence as it is", () => {
    render(<Screen onSetUp={vi.fn()} />);
    const summary =
      'Project lantern: roubo.yaml not applied. .roubo/roubo.yaml: components.web: Unrecognized key: "command". Last good config is still live.';
    act(() =>
      publishInputChanged(
        rejected({
          projectId: "lantern",
          summary,
          error: {
            path: ".roubo/roubo.yaml",
            first: 'components.web: Unrecognized key: "command".',
          },
        }),
      ),
    );
    expect(notices()[0].querySelector("p")?.textContent).toBe(
      'Project lantern: roubo.yaml not applied. .roubo/roubo.yaml: components.web: Unrecognized key: "command". Last good config is still live.',
    );
  });

  // The summaries below are what the server's rejectedConfigSummary writes for
  // a roubo.yaml save that is not applied.
  it("HR-TC-038 renders the server's rejected roubo.yaml summary once, with the path, the first error and one last-good line", () => {
    render(<Screen onSetUp={vi.fn()} />);
    const first = "components.web.command must be a string or array";
    const summary =
      "Project lantern: roubo.yaml not applied. .roubo/roubo.yaml: components.web.command must be a string or array. Last good config is still live.";
    act(() =>
      publishInputChanged(
        rejected({ projectId: "lantern", summary, error: { path: ".roubo/roubo.yaml", first } }),
      ),
    );
    const text = notices()[0].querySelector("p")?.textContent ?? "";
    expect(text).toBe(summary);
    expect(text.split(".roubo/roubo.yaml").length - 1).toBe(1);
    expect(text.split(first).length - 1).toBe(1);
    expect(text.match(/last good/gi)).toHaveLength(1);
  });

  it("HR-TC-004 a rejected roubo.yaml of a project with no last good config does not claim one is live", () => {
    render(<Screen onSetUp={vi.fn()} />);
    const first = "components.web.command must be a string or array";
    const summary = `Project lantern: roubo.yaml not applied. .roubo/roubo.yaml: ${first}.`;
    act(() =>
      publishInputChanged(
        rejected({ projectId: "lantern", summary, error: { path: ".roubo/roubo.yaml", first } }),
      ),
    );
    const text = notices()[0].querySelector("p")?.textContent ?? "";
    expect(text).toBe(summary);
    expect(text).not.toMatch(/last good/i);
  });
});
