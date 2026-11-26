import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import {
  NEWER_VERSION,
  PROJECT_ID,
  TOGGLED_PLUGIN_ID,
  UPDATED_PLUGIN_ID,
  getPlugin,
  pollUntil,
  readJson,
  writeJson,
  updateDatabase,
  type LanternProject,
} from "./reload-env.js";
import { renderSample, type NoticeInput } from "./notice-samples.js";

// One applied change of each input the app watches, made from outside the app
// as a user makes it, for the cross-surface cases. The inputs are the ones the
// client tells apart (client/src/lib/input-changed.ts, ChangedInput): a
// project's roubo.yaml, a plugin folder, and the state files settings.json,
// projects.json, state.json, auth.json, plugins-consent.json,
// plugins-state.json and .env.
//
// Each save is the n-th of its input and differs from the one before it, so
// the watch applies it rather than deduping it. `notice` tells the notice of
// that save from every other notice.

export type ChangedInput = NoticeInput;

export const CHANGED_INPUTS: readonly ChangedInput[] = [
  "project-config",
  "plugin",
  "settings",
  "projects",
  "bench-state",
  "auth",
  "consent",
  "plugin-state",
  "env",
];

export interface SurfaceContext {
  request: APIRequestContext;
  rouboDir: string;
  project: LanternProject;
  /** A bench of lantern that is not live, whose state.json record a save may edit. */
  idleBenchId: number;
  /** Where the projects surface puts the checkout of the project it adds. */
  scratchDir: string;
}

export interface Save {
  /** Make the change. Resolves the moment the write (or the request) has returned. */
  write: () => void | Promise<void>;
  /** The notice line this save shows, from the recorded samples. */
  expected: string;
  /**
   * Whether a notice's text is the notice of this save. A roubo.yaml or plugin
   * notice can go on to name the benches the change reached, so those match
   * on their start.
   */
  notice: (text: string) => boolean;
}

export interface Surface {
  input: ChangedInput;
  /** The file a save writes, for the record of a failure. */
  file: (ctx: SurfaceContext) => string;
  /** Prepare the n-th save (n from 1). Reads what it needs before the timer starts. */
  save: (ctx: SurfaceContext, n: number) => Promise<Save>;
}

/** The second project the projects surface adds and removes again. */
export const ADDED_PROJECT_ID = "lantern-2";
const ADDED_PROJECT_PORT_BASE = 39_800;

function tildePath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function addedProjectYaml(): string {
  return `project:
  name: ${ADDED_PROJECT_ID}
  displayName: Lantern 2
  type: web
layout:
  type: single-repo
components:
  app:
    plugin:
      id: process
    config:
      command: "true"
ports:
  app:
    base: ${ADDED_PROJECT_PORT_BASE}
benches:
  max: 1
`;
}

/** The component plugin that the consent surface consents: it waits for consent until then. */
export const CONSENT_PLUGIN_ID = "hr-consent-stub";
/** The plugin's template: the fixture integration plugin whose runtime the copy runs. */
const CONSENT_TEMPLATE_ID = "e2e-stub-5";
let consentPluginDir: string | null = null;

/**
 * Put the plugin the consent surface consents in the plugins root, as a user
 * drops a plugin folder, and wait until the server has registered it. It is a
 * copy of the fixture plugin as a component plugin, so the server holds it
 * until a consent record names it.
 */
async function putConsentPlugin(request: APIRequestContext): Promise<void> {
  const template = (await getPlugin(request, CONSENT_TEMPLATE_ID)) as
    { manifestPath?: string } | undefined;
  if (!template?.manifestPath)
    throw new Error(`the fixture plugin ${CONSENT_TEMPLATE_ID} is missing`);
  const templateDir = path.dirname(template.manifestPath);
  const dir = path.join(path.dirname(templateDir), CONSENT_PLUGIN_ID);
  // A copy that an earlier run left is removed before the plugin is registered.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  consentPluginDir = dir;
  fs.copyFileSync(path.join(templateDir, "index.mjs"), path.join(dir, "index.mjs"));
  const manifest = fs
    .readFileSync(template.manifestPath, "utf-8")
    .replace(/^id: .*$/m, `id: ${CONSENT_PLUGIN_ID}`)
    .replace(/^name: .*$/m, "name: Hot-reload consent stub")
    .replace(/^kind: .*$/m, "kind: component\ncontractVersion: 1\ndescriptorSchemaVersion: 1");
  fs.writeFileSync(path.join(dir, "roubo-plugin.yaml"), manifest);
  const registered = await pollUntil(
    () => getPlugin(request, CONSENT_PLUGIN_ID),
    (p) => p !== undefined,
    15_000,
    250,
  );
  if (registered === undefined) throw new Error(`the server did not register ${CONSENT_PLUGIN_ID}`);
}

/** Take the consent plugin's folder back out of the plugins root. */
function removeConsentPlugin(): void {
  if (consentPluginDir !== null) fs.rmSync(consentPluginDir, { recursive: true, force: true });
  consentPluginDir = null;
}

/** The checkout of lantern-2, made once per context. */
function addedProjectCheckout(ctx: SurfaceContext): string {
  const repoPath = path.join(ctx.scratchDir, ADDED_PROJECT_ID);
  const configFile = path.join(repoPath, ".roubo", "roubo.yaml");
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, addedProjectYaml());
  }
  return repoPath;
}

function readOr<T>(file: string, fallback: T): T {
  try {
    return readJson<T>(file);
  } catch {
    return fallback;
  }
}

function stateFile(ctx: SurfaceContext, name: string): string {
  return path.join(ctx.rouboDir, name);
}

/** The installed copy of the plugin the plugin surface edits. */
async function pluginManifest(ctx: SurfaceContext): Promise<string> {
  const plugin = (await getPlugin(ctx.request, UPDATED_PLUGIN_ID)) as
    { manifestPath?: string } | undefined;
  if (!plugin?.manifestPath) {
    throw new Error(`the plugin surface needs ${UPDATED_PLUGIN_ID} installed`);
  }
  return plugin.manifestPath;
}

export const SURFACES: Record<ChangedInput, Surface> = {
  "project-config": {
    input: "project-config",
    file: (ctx) => ctx.project.configFile,
    save: async (ctx, n) => {
      const current = fs.readFileSync(ctx.project.configFile, "utf-8").replace(/# save \d+\n$/, "");
      const expected = renderSample("project-config", { projectId: PROJECT_ID });
      return {
        write: () => fs.writeFileSync(ctx.project.configFile, `${current}# save ${n}\n`),
        expected,
        notice: (text) => text.startsWith(expected),
      };
    },
  },
  plugin: {
    input: "plugin",
    file: () => `${UPDATED_PLUGIN_ID}/roubo-plugin.yaml`,
    save: async (ctx, n) => {
      // A hand edit of the installed manifest: the watch swaps the plugin's
      // process for the edited copy, keeping every bench resource. A hand edit
      // keeps the version, so its notice names none ("Plugin database
      // updated."); the recorded sample is that of a marketplace update, which
      // marketplaceUpdate below makes.
      const manifest = await pluginManifest(ctx);
      const current = fs.readFileSync(manifest, "utf-8").replace(/\n# save \d+\n$/, "\n");
      const expected = `Plugin ${UPDATED_PLUGIN_ID} updated.`;
      return {
        write: () => fs.writeFileSync(manifest, `${current}# save ${n}\n`),
        expected,
        notice: (text) => text.startsWith(expected),
      };
    },
  },
  settings: {
    input: "settings",
    file: (ctx) => stateFile(ctx, "settings.json"),
    save: async (ctx) => {
      const file = stateFile(ctx, "settings.json");
      const current = readOr<Record<string, unknown>>(file, {});
      // Change the theme from the one the server serves, which a missing file
      // leaves at its default.
      const served = await ctx.request.get("/api/settings");
      const { theme: servedTheme } = served.ok()
        ? ((await served.json()) as { theme?: unknown })
        : { theme: current.theme };
      const theme = servedTheme === "dark" ? "light" : "dark";
      // Tab indented, so the bytes are never those of a write by the app,
      // which the watch would take for its own write and leave alone.
      return {
        write: () =>
          fs.writeFileSync(file, `${JSON.stringify({ ...current, theme }, null, "\t")}\n`),
        expected: renderSample("settings", { settings: "theme" }),
        notice: (text) => text === renderSample("settings", { settings: "theme" }),
      };
    },
  },
  projects: {
    input: "projects",
    file: (ctx) => stateFile(ctx, "projects.json"),
    save: async (ctx) => {
      const file = stateFile(ctx, "projects.json");
      const current = readOr<{ projects?: { id: string }[] }>(file, { projects: [] });
      const projects = current.projects ?? [];
      const listed = projects.some((p) => p.id === ADDED_PROJECT_ID);
      const repoPath = addedProjectCheckout(ctx);
      // Every other save removes the project the save before it added.
      const next = listed
        ? projects.filter((p) => p.id !== ADDED_PROJECT_ID)
        : [...projects, { id: ADDED_PROJECT_ID, repoPath }];
      const expected = listed
        ? `Project ${ADDED_PROJECT_ID} unregistered.`
        : renderSample("projects", { projectId: ADDED_PROJECT_ID, path: tildePath(repoPath) });
      return {
        write: () => writeJson(file, { ...current, projects: next }),
        expected,
        notice: (text) => text === expected,
      };
    },
  },
  "bench-state": {
    input: "bench-state",
    file: (ctx) => stateFile(ctx, "state.json"),
    save: async (ctx, n) => {
      const file = stateFile(ctx, "state.json");
      const current = readJson<{
        benches: { id: number; projectId: string; branch: string }[];
      }>(file);
      const benches = current.benches.map((b) =>
        b.projectId === PROJECT_ID && b.id === ctx.idleBenchId
          ? { ...b, branch: `hardening/save-${n}` }
          : b,
      );
      const expected = renderSample("bench-state", {
        benchId: ctx.idleBenchId,
        projectId: PROJECT_ID,
      });
      return {
        write: () => writeJson(file, { ...current, benches }),
        expected,
        notice: (text) => text === expected,
      };
    },
  },
  auth: {
    input: "auth",
    file: (ctx) => stateFile(ctx, "auth.json"),
    save: async (ctx, n) => {
      const file = stateFile(ctx, "auth.json");
      return {
        write: () => writeJson(file, { githubToken: `e2e-hardening-token-${n}` }),
        expected: renderSample("auth"),
        notice: (text) => text === renderSample("auth"),
      };
    },
  },
  consent: {
    input: "consent",
    file: (ctx) => stateFile(ctx, "plugins-consent.json"),
    save: async (ctx, n) => {
      const file = stateFile(ctx, "plugins-consent.json");
      // The first save consents a component plugin that waits for it, so the
      // save starts it and the notice names it. Later saves consent the same
      // plugin again, which starts nothing, so their notice names none.
      if (n === 1) await putConsentPlugin(ctx.request);
      const current = readOr<{ schemaVersion: number; plugins: Record<string, unknown> }>(file, {
        schemaVersion: 1,
        plugins: {},
      });
      const consentedAt = new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();
      const plugins = {
        ...current.plugins,
        [CONSENT_PLUGIN_ID]: {
          pluginId: CONSENT_PLUGIN_ID,
          acknowledgedCategories: [],
          consentedAt,
        },
      };
      const expected =
        n === 1
          ? renderSample("consent", { pluginIds: CONSENT_PLUGIN_ID })
          : "Plugin consent applied.";
      return {
        write: () => writeJson(file, { ...current, plugins }),
        expected,
        notice: (text) => text === expected,
      };
    },
  },
  "plugin-state": {
    input: "plugin-state",
    file: (ctx) => stateFile(ctx, "plugins-state.json"),
    save: async (ctx) => {
      const file = stateFile(ctx, "plugins-state.json");
      const current = readJson<{ plugins: Record<string, string> }>(file);
      const disable = current.plugins[TOGGLED_PLUGIN_ID] !== "disabled";
      const plugins = { ...current.plugins, [TOGGLED_PLUGIN_ID]: disable ? "disabled" : "enabled" };
      const expected = disable
        ? renderSample("plugin-state", { pluginId: TOGGLED_PLUGIN_ID })
        : `Plugin ${TOGGLED_PLUGIN_ID} enabled.`;
      return {
        write: () => writeJson(file, { ...current, plugins }),
        expected,
        notice: (text) => text === expected,
      };
    },
  },
  env: {
    input: "env",
    file: (ctx) => stateFile(ctx, ".env"),
    save: async (ctx, n) => {
      const file = stateFile(ctx, ".env");
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      const kept = current
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("HR_E2E_PROBE="));
      const next = [...kept, `HR_E2E_PROBE=${n}`].join("\n");
      return {
        write: () => fs.writeFileSync(file, `${next}\n`),
        expected: renderSample("env", { count: 1 }),
        notice: (text) => text === renderSample("env", { count: 1 }),
      };
    },
  },
};

/** What the state files held before a case, so the case can put them back. */
export function snapshotStateFiles(rouboDir: string): Map<string, string | null> {
  const files = [
    "settings.json",
    "auth.json",
    "plugins-consent.json",
    "plugins-state.json",
    ".env",
  ];
  return new Map(
    files.map((name) => {
      const file = path.join(rouboDir, name);
      return [file, fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null];
    }),
  );
}

export function restoreStateFiles(snapshot: Map<string, string | null>): void {
  removeConsentPlugin();
  for (const [file, content] of snapshot) {
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
}

/**
 * The plugin update of HR-FR-007: a marketplace update of the installed
 * 'database' from 1.0.0 to 1.1.0, which swaps its process in place. Its notice
 * is the recorded sample of the plugin input; it can go on to count the
 * benches that kept their components. One per installed copy: the e2e catalog
 * serves no version above 1.1.0.
 */
export function marketplaceUpdate(ctx: SurfaceContext): Save {
  const expected = renderSample("plugin", {
    pluginId: UPDATED_PLUGIN_ID,
    version: NEWER_VERSION,
    kept: "",
  });
  return {
    write: () => updateDatabase(ctx.request),
    expected,
    notice: (text) => text.startsWith(expected),
  };
}
