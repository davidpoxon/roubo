// The recorded notice samples of HR-TC-036: the one line the notice list
// shows for one applied change of each input, as a template whose {names} a
// case fills with the ids of its own run. Both the server unit test
// (server/services/input-notice-copy.test.ts), which renders each sample
// through the server's notice copy and the client's notice line, and the e2e
// case (e2e/hot-reload/notice-copy-per-surface.spec.ts), which reads each
// notice off the screen, compare against this one table.
//
// The inputs are the ones the client tells apart (ChangedInput in
// client/src/lib/input-changed.ts). Each notice is one line and starts with
// the surface's thing.

export type NoticeInput =
  | "project-config"
  | "plugin"
  | "settings"
  | "projects"
  | "bench-state"
  | "auth"
  | "consent"
  | "plugin-state"
  | "env";

export interface NoticeSample {
  /** The word the notice starts with. */
  thing: "Project" | "Plugin" | "Settings" | "Bench" | "GitHub" | "Environment";
  /** The notice line, with {names} for the ids of a run. */
  template: string;
}

export const NOTICE_SAMPLES: Record<NoticeInput, NoticeSample> = {
  "project-config": { thing: "Project", template: "Project {projectId}: roubo.yaml applied." },
  plugin: { thing: "Plugin", template: "Plugin {pluginId} updated to {version}." },
  settings: { thing: "Settings", template: "Settings applied: {settings}." },
  projects: { thing: "Project", template: "Project {projectId} registered from {path}." },
  "bench-state": {
    thing: "Bench",
    template: "Bench state applied: bench {benchId} on {projectId}.",
  },
  auth: { thing: "GitHub", template: "GitHub credentials applied." },
  consent: { thing: "Plugin", template: "Plugin consent applied." },
  "plugin-state": { thing: "Plugin", template: "Plugin {pluginId} disabled." },
  env: { thing: "Environment", template: "Environment file applied: {count} key changed." },
};

/** The sample of `input` with each {name} replaced by its value in `vars`. */
export function renderSample(
  input: NoticeInput,
  vars: Record<string, string | number> = {},
): string {
  return NOTICE_SAMPLES[input].template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`the ${input} sample needs a value for {${name}}`);
    return String(value);
  });
}
