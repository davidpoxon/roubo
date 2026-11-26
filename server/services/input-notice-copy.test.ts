/**
 * HR-TC-036: the notice of one applied change of each input, as the server
 * words it and the client shows it, equals its recorded sample
 * (e2e/hot-reload/_support/notice-samples.ts), and is one line that starts
 * with the surface's thing. The e2e case
 * (e2e/hot-reload/notice-copy-per-surface.spec.ts) reads the same samples off
 * the screen of a running app.
 *
 * Each row builds the event the surface's handler sends, with the server's
 * own notice copy, and renders it through the client's `inputNoticeText`.
 */
import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { InputChangedEvent, InputSurface } from "@roubo/shared";

// The state dir watch's collaborators are not run here: only its notice copy is.
vi.mock("./bench-manager.js", () => ({ applyStateFileEdit: vi.fn() }));
vi.mock("./plugin-manager.js", () => ({
  startAfterConsent: vi.fn(),
  reloadEnableState: vi.fn(),
  HOST_API_VERSION: "1.9.0",
}));
vi.mock("./project-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-registry.js")>();
  return { ...actual, applyProjectsFileEdit: vi.fn() };
});

import { inputNoticeText, surfaceThing } from "../../client/src/lib/input-changed";
import {
  NOTICE_SAMPLES,
  renderSample,
  type NoticeInput,
} from "../../e2e/hot-reload/_support/notice-samples";
import { appliedConfigSummary } from "./project-registry.js";
import { updatedNotice } from "./plugin-dir-watch.js";
import { settingsAppliedNotice } from "./settings-changes.js";
import {
  GITHUB_CREDENTIALS_APPLIED_NOTICE,
  benchAppliedNotice,
  consentAppliedNotice,
  enableStateNotice,
  envFileAppliedNotice,
  projectRegisteredNotice,
} from "./state-dir-watch.js";

const PROJECT_ID = "lantern";
const ADDED_PROJECT_ID = "lantern-2";
const ADDED_PROJECT_PATH = path.join(os.homedir(), "Developer", ADDED_PROJECT_ID);
const PLUGIN_ID = "database";
const TOGGLED_PLUGIN_ID = "e2e-stub-5";

interface Row {
  surface: InputSurface;
  input?: string;
  summary: string;
  vars: Record<string, string | number>;
}

/** The event of one applied change of each input, with the server's notice copy. */
const ROWS: Record<NoticeInput, Row> = {
  "project-config": {
    surface: "project-config",
    summary: appliedConfigSummary(PROJECT_ID, 0),
    vars: { projectId: PROJECT_ID },
  },
  plugin: {
    surface: "plugin",
    summary: updatedNotice(PLUGIN_ID, "1.1.0", 0),
    vars: { pluginId: PLUGIN_ID, version: "1.1.0" },
  },
  settings: {
    surface: "settings",
    input: "settings.json",
    summary: settingsAppliedNotice(["theme"]),
    vars: { settings: "theme" },
  },
  projects: {
    surface: "project-config",
    input: "projects.json",
    summary: projectRegisteredNotice(ADDED_PROJECT_ID, ADDED_PROJECT_PATH),
    vars: { projectId: ADDED_PROJECT_ID, path: `~/Developer/${ADDED_PROJECT_ID}` },
  },
  "bench-state": {
    surface: "bench",
    input: "state.json",
    summary: benchAppliedNotice([{ projectId: PROJECT_ID, benchId: 2 }]),
    vars: { benchId: 2, projectId: PROJECT_ID },
  },
  auth: {
    surface: "github",
    input: "auth.json",
    summary: GITHUB_CREDENTIALS_APPLIED_NOTICE,
    vars: {},
  },
  consent: {
    surface: "plugin",
    input: "plugins-consent.json",
    summary: consentAppliedNotice([]),
    vars: {},
  },
  "plugin-state": {
    surface: "plugin",
    input: "plugins-state.json",
    summary: enableStateNotice({ disabled: [TOGGLED_PLUGIN_ID], enabled: [] }),
    vars: { pluginId: TOGGLED_PLUGIN_ID },
  },
  env: {
    surface: "environment",
    input: ".env",
    summary: envFileAppliedNotice(1),
    vars: { count: 1 },
  },
};

function noticeOf(row: Row): string {
  const event: InputChangedEvent = {
    type: "input-changed",
    surface: row.surface,
    outcome: "applied",
    ...(row.input === undefined ? {} : { input: row.input }),
    summary: row.summary,
  };
  return inputNoticeText(event);
}

describe("HR-TC-036: notice text per surface matches the recorded samples", () => {
  it("HR-TC-036: every input the client tells apart has a recorded sample", () => {
    expect(Object.keys(ROWS).sort()).toEqual(Object.keys(NOTICE_SAMPLES).sort());
  });

  for (const input of Object.keys(ROWS) as NoticeInput[]) {
    it(`HR-TC-036: the ${input} notice equals its sample, on one line, starting with its thing`, () => {
      const row = ROWS[input];
      const text = noticeOf(row);
      expect(text).toBe(renderSample(input, row.vars));
      expect(text).not.toContain("\n");
      expect(surfaceThing(row.surface)).toBe(NOTICE_SAMPLES[input].thing);
      expect(text.startsWith(NOTICE_SAMPLES[input].thing)).toBe(true);
    });
  }
});
