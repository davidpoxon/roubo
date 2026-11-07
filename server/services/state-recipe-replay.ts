// The state recipe replayer of a gate sitting (SB-FR-025, SB-US-009): it puts
// the pinned checkout of a Spec Bench into the state one test case observes, by
// replaying the case's state recipe there under a commit guard.
//
// The recipe of a case lives beside the delivery record, in the pin checkout:
// `<pin>/.specifications/<slug>/state-recipes/<caseId>.json`. Staging a case:
//   1. reads the recipe; a case with none opens cold (StateRecipeNotFoundError);
//   2. validates it against the published state recipe contract before any
//      step runs (StateRecipeInvalidError);
//   3. checks its `commit` against the pin commit: a recipe recorded at another
//      commit is refused (StateRecipeCommitMismatchError). An abbreviated
//      recipe commit matches when it is a prefix of the full pin commit;
//   4. replays its steps in order in the pin checkout, and stops at the first
//      step that fails, marking the steps after it skipped.
//
// The replayer runs only the four step kinds of the contract: command,
// copy-file, http and open-url. A step of any other kind is refused before any
// step runs. The server opens no browser: an open-url step records its URL in
// the report, for the client to open.
import fs from "node:fs";
import path from "node:path";
import type { Bench } from "@roubo/shared";
import {
  validateStateRecipe,
  type CommandStep,
  type CopyFileStep,
  type HttpStep,
  type StateRecipe,
  type StateRecipeObservation,
  type StateRecipeStep,
  STATE_RECIPE_STEP_KINDS,
} from "@roubo/shared/state-recipe-contract";
import { assertSafeWorkspacePath, resolveWithin, UnsafePathError } from "../lib/safe-path.js";
import { runCommand } from "./exec.js";

/** The folder of a spec that holds its state recipes, one `<caseId>.json` per case. */
export const STATE_RECIPES_DIR = "state-recipes";

/** The time budget of a command step that names none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** The time budget of an http step that names none. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

// The most of a command's output a failed step's detail carries.
const DETAIL_OUTPUT_CHARS = 2_000;

// A case id as a file name: no separator, no parent, nothing a shell reads.
const CASE_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
// A commit as a recipe names it: an abbreviated or full hex object name.
const COMMIT_RE = /^[0-9a-f]{4,64}$/i;

export type StateRecipeStepStatus = "passed" | "failed" | "skipped";

/** What became of one step of a replay. */
export interface StateRecipeStepReport {
  index: number;
  kind: string;
  status: StateRecipeStepStatus;
  /** Why the step failed, or what it did. */
  detail?: string;
  /** The URL an open-url step asks the client to open. */
  url?: string;
}

/** The report of a replay: the recipe it replayed, and what became of each step. */
export interface StateRecipeReplayReport {
  caseId: string;
  unitId: string;
  commit: string;
  observation: StateRecipeObservation;
  steps: StateRecipeStepReport[];
}

/** The outcome of a replay: `ok` when every step passed. */
export interface StateRecipeReplayResult {
  ok: boolean;
  report: StateRecipeReplayReport;
}

/** The case has no state recipe in the pin checkout, so it opens cold. */
export class StateRecipeNotFoundError extends Error {
  readonly code = "RECIPE_NOT_FOUND";
  constructor(caseId: string) {
    super(`Case ${caseId} has no state recipe, so it opens cold`);
    this.name = "StateRecipeNotFoundError";
  }
}

/** The recipe file does not validate against the state recipe contract. */
export class StateRecipeInvalidError extends Error {
  readonly code = "RECIPE_INVALID";
  constructor(
    caseId: string,
    readonly errors: string[],
  ) {
    super(`The state recipe of case ${caseId} is not valid`);
    this.name = "StateRecipeInvalidError";
  }
}

/** The recipe was recorded at another commit than the pin, or the bench has no pin to replay in. */
export class StateRecipeCommitMismatchError extends Error {
  constructor(
    message: string,
    readonly code: "RECIPE_COMMIT_MISMATCH" | "NO_GATE_PIN",
    readonly pinCommit?: string,
    readonly recipeCommit?: string,
  ) {
    super(message);
    this.name = "StateRecipeCommitMismatchError";
  }
}

/** A step of a kind the replayer does not run. */
export class UnknownStateRecipeStepError extends Error {
  readonly code = "RECIPE_STEP_KIND_UNKNOWN";
  constructor(
    readonly index: number,
    readonly kind: unknown,
  ) {
    super(
      `Step ${index} has the unknown kind ${JSON.stringify(kind)}: the replayer runs only ${STATE_RECIPE_STEP_KINDS.join(", ")}`,
    );
    this.name = "UnknownStateRecipeStepError";
  }
}

/** What the replayer reaches outside itself; tests swap them. */
export interface StateRecipeReplayDeps {
  runCommand: typeof runCommand;
  fetch: typeof fetch;
}

const defaultDeps: StateRecipeReplayDeps = {
  runCommand,
  fetch: (...args) => fetch(...args),
};

/** True when the recipe's commit names the pin commit: the same, or an abbreviation of it. */
export function recipeCommitMatches(recipeCommit: string, pinCommit: string): boolean {
  if (!COMMIT_RE.test(recipeCommit)) return false;
  return pinCommit.toLowerCase().startsWith(recipeCommit.toLowerCase());
}

/** The absolute path of a case's state recipe in a checkout; throws UnsafePathError when it would leave the folder. */
export function stateRecipePath(checkout: string, slug: string, caseId: string): string {
  if (!CASE_ID_RE.test(caseId)) {
    throw new UnsafePathError(`Invalid case id: ${caseId}`);
  }
  return resolveWithin(checkout, ".specifications", slug, STATE_RECIPES_DIR, `${caseId}.json`);
}

/**
 * Reads and validates the state recipe of a case in a checkout. Throws
 * StateRecipeNotFoundError when it has none, and StateRecipeInvalidError when
 * the file is not JSON, does not validate against the contract, or names
 * another case.
 */
export function loadStateRecipe(checkout: string, slug: string, caseId: string): StateRecipe {
  const file = stateRecipePath(checkout, slug, caseId);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateRecipeNotFoundError(caseId);
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new StateRecipeInvalidError(caseId, [`not valid JSON: ${(err as Error).message}`]);
  }
  const validated = validateStateRecipe(raw);
  if (!validated.ok) throw new StateRecipeInvalidError(caseId, validated.errors);
  if (validated.data.caseId !== caseId) {
    throw new StateRecipeInvalidError(caseId, [
      `caseId: the recipe is for case ${validated.data.caseId}`,
    ]);
  }
  return validated.data;
}

// A path of a step: absolute as given, else under the checkout, which it must
// not leave.
function stepPath(checkout: string, raw: string): string {
  return path.isAbsolute(raw) ? raw : resolveWithin(checkout, raw);
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= DETAIL_OUTPUT_CHARS
    ? trimmed
    : `...${trimmed.slice(-DETAIL_OUTPUT_CHARS)}`;
}

async function runCommandStep(
  step: CommandStep,
  checkout: string,
  deps: StateRecipeReplayDeps,
): Promise<Omit<StateRecipeStepReport, "index" | "kind">> {
  const cwd = resolveWithin(checkout, step.cwd ?? ".");
  const expected = step.expectedExitCode ?? 0;
  const timeoutMs = step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const result = await deps.runCommand("/bin/sh", ["-c", step.command], cwd, step.env, timeoutMs);
  // A command stopped at its time budget reports exit 1, so it fails before the
  // exit-code comparison: a step that expects 1 must not pass on a timeout.
  if (result.timedOut === true) {
    const output = tail(result.stderr) || tail(result.stdout);
    return {
      status: "failed",
      detail: `ran past its time budget of ${timeoutMs}ms${output ? `: ${output}` : ""}`,
    };
  }
  if (result.code === expected) {
    return { status: "passed", detail: `exited ${result.code}` };
  }
  const output = tail(result.stderr) || tail(result.stdout);
  return {
    status: "failed",
    detail: `exited ${result.code}, expected ${expected}${output ? `: ${output}` : ""}`,
  };
}

function runCopyFileStep(
  step: CopyFileStep,
  checkout: string,
): Omit<StateRecipeStepReport, "index" | "kind"> {
  const from = stepPath(checkout, step.from);
  const to = stepPath(checkout, step.to);
  const mode = step.mode ?? "overwrite";
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, mode === "create-only" ? fs.constants.COPYFILE_EXCL : 0);
  return { status: "passed", detail: `copied ${step.from} to ${step.to}` };
}

async function runHttpStep(
  step: HttpStep,
  deps: StateRecipeReplayDeps,
): Promise<Omit<StateRecipeStepReport, "index" | "kind">> {
  const res = await deps.fetch(step.url, {
    method: step.method,
    ...(step.headers !== undefined && { headers: step.headers }),
    ...(step.body !== undefined && { body: step.body }),
    redirect: "manual",
    signal: AbortSignal.timeout(step.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
  });
  await res.body?.cancel();
  const passed =
    step.expectedStatus === undefined
      ? res.status >= 200 && res.status < 300
      : res.status === step.expectedStatus;
  if (passed) return { status: "passed", detail: `answered ${res.status}` };
  const expected = step.expectedStatus === undefined ? "a 2xx" : String(step.expectedStatus);
  return { status: "failed", detail: `answered ${res.status}, expected ${expected}` };
}

// Runs one step by its kind. The switch names every kind of the contract and
// refuses any other.
async function runStep(
  step: StateRecipeStep,
  index: number,
  checkout: string,
  deps: StateRecipeReplayDeps,
): Promise<Omit<StateRecipeStepReport, "index" | "kind">> {
  switch (step.kind) {
    case "command":
      return runCommandStep(step, checkout, deps);
    case "copy-file":
      return runCopyFileStep(step, checkout);
    case "http":
      return runHttpStep(step, deps);
    case "open-url":
      return {
        status: "passed",
        detail: "open the URL to look at the staged state",
        url: step.url,
      };
    default: {
      const unknown: never = step;
      throw new UnknownStateRecipeStepError(index, (unknown as { kind?: unknown }).kind);
    }
  }
}

function isKnownKind(kind: unknown): boolean {
  return (STATE_RECIPE_STEP_KINDS as readonly unknown[]).includes(kind);
}

/**
 * Replays the steps of a recipe in order in `checkout`. Each step of an unknown
 * kind is refused with UnknownStateRecipeStepError before any step runs. The
 * first step that fails, or throws, is reported `failed` with its detail, and
 * each step after it `skipped`.
 */
export async function replayStateRecipe(
  recipe: StateRecipe,
  checkout: string,
  deps: StateRecipeReplayDeps = defaultDeps,
): Promise<StateRecipeReplayResult> {
  recipe.steps.forEach((step, index) => {
    const kind = (step as { kind?: unknown }).kind;
    if (!isKnownKind(kind)) throw new UnknownStateRecipeStepError(index, kind);
  });
  const steps: StateRecipeStepReport[] = [];
  let failed = false;
  for (const [index, step] of recipe.steps.entries()) {
    if (failed) {
      steps.push({ index, kind: step.kind, status: "skipped" });
      continue;
    }
    let outcome: Omit<StateRecipeStepReport, "index" | "kind">;
    try {
      outcome = await runStep(step, index, checkout, deps);
    } catch (err) {
      if (err instanceof UnknownStateRecipeStepError) throw err;
      outcome = { status: "failed", detail: (err as Error).message };
    }
    steps.push({ index, kind: step.kind, ...outcome });
    if (outcome.status === "failed") failed = true;
  }
  return {
    ok: !failed,
    report: {
      caseId: recipe.caseId,
      unitId: recipe.unitId,
      commit: recipe.commit,
      observation: recipe.observation,
      steps,
    },
  };
}

/**
 * Stages a case of a bench's gate sitting: reads the case's recipe from the
 * pin checkout, checks it against the pin commit, and replays it there. Throws
 * StateRecipeCommitMismatchError (code NO_GATE_PIN) when the bench has no pin
 * with a commit, StateRecipeNotFoundError when the case has no recipe,
 * StateRecipeInvalidError when the recipe does not validate, and
 * StateRecipeCommitMismatchError (code RECIPE_COMMIT_MISMATCH) when the recipe
 * names another commit.
 */
export async function stageCaseFromRecipe(
  bench: Pick<Bench, "gatePin">,
  slug: string,
  caseId: string,
  deps: StateRecipeReplayDeps = defaultDeps,
): Promise<StateRecipeReplayResult> {
  const pin = bench.gatePin;
  if (pin === undefined || pin.commit === undefined) {
    throw new StateRecipeCommitMismatchError(
      "The bench has no gate pin, so there is no pinned checkout to stage the case in: open the gate sitting first",
      "NO_GATE_PIN",
    );
  }
  const checkout = assertSafeWorkspacePath(pin.workspacePath, "gate pin path");
  const recipe = loadStateRecipe(checkout, slug, caseId);
  if (!recipeCommitMatches(recipe.commit, pin.commit)) {
    throw new StateRecipeCommitMismatchError(
      `The state recipe of case ${caseId} was recorded at commit ${recipe.commit}, not at the pin commit ${pin.commit}`,
      "RECIPE_COMMIT_MISMATCH",
      pin.commit,
      recipe.commit,
    );
  }
  return replayStateRecipe(recipe, checkout, deps);
}
