// APCC-TC-010 (#1264): the notification union is defined twice, once as
// the authoritative Zod schema in shared/ and once as the structural copy the
// plugin SDK ships, and the two must carry the same members.
//
// The check is a type-level one, so it is only worth anything if a compiler
// actually runs it. Test files are outside every `tsc --noEmit` project here,
// which is why this suite drives the TypeScript compiler itself: it type-checks
// a small in-memory program asserting mutual assignability, and a deliberately
// drifted twin of it to prove the assertion is not vacuous.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The assertion. `Mutual` is `true` only when each side is assignable to the
 * other, so a member present on one side and missing from the other, or a
 * field that differs between them, turns a `const` into a type error.
 *
 * One pre-existing, deliberate difference is factored out rather than asserted
 * away: the SDK types a `set` write op's `value` as `unknown`, where the schema
 * narrows it to JSON. So the members are compared with each carrier's
 * `workspaceWrite` reduced to a marker, and the write spec itself is checked in
 * the one direction that holds, schema into SDK, which is the direction a
 * plugin author relies on.
 */
function paritySource(sdkType: string): string {
  return `
import type { z } from "zod";
import type {
  NotificationWiringSchema,
  WorkspaceWriteSpecSchema,
} from "./agent-launch-descriptor-schema";
import type {
  NotificationWiring as SdkNotificationWiring,
  WorkspaceWriteSpec as SdkWorkspaceWriteSpec,
} from "../plugin-sdk/src/types";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Carrier<C> = { [K in keyof C]: K extends "workspaceWrite" ? "workspace-write" : C[K] };
type Member<T> = T extends unknown
  ? { [K in keyof T]: K extends "carrier" ? Carrier<T[K]> : T[K] }
  : never;

type Schema = z.infer<typeof NotificationWiringSchema>;
type Sdk = ${sdkType};

export const sameKinds: Mutual<Schema["kind"], Sdk["kind"]> = true;
export const sameMembers: Mutual<Member<Schema>, Member<Sdk>> = true;
export const writeFits: [z.infer<typeof WorkspaceWriteSpecSchema>] extends [SdkWorkspaceWriteSpec]
  ? true
  : false = true;
`;
}

/** Type-check one in-memory file beside the schema; returns its diagnostics. */
function typeCheck(source: string): string[] {
  const fileName = path.join(HERE, "__notification-wiring-parity__.ts");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (
    (exists) => (f: string) =>
      f === fileName || exists(f)
  )(host.fileExists.bind(host));
  host.readFile = (f) => (f === fileName ? source : readFile(f));
  host.getSourceFile = (f, languageVersion, onError, shouldCreate) =>
    f === fileName
      ? ts.createSourceFile(f, source, languageVersion, true)
      : getSourceFile(f, languageVersion, onError, shouldCreate);

  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(fileName))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("NotificationWiring parity between the schema and the SDK (APCC-TC-010)", () => {
  it("carries the same members at both definition sites", () => {
    expect(typeCheck(paritySource("SdkNotificationWiring"))).toEqual([]);
  }, 30_000);

  it("fails when the SDK copy drops a member the schema carries", () => {
    const drifted = typeCheck(
      paritySource('Exclude<SdkNotificationWiring, { kind: "file-notifier" }>'),
    );
    // A parity failure, not some unrelated compile error.
    expect(drifted).toContain("Type 'true' is not assignable to type 'false'.");
  }, 30_000);

  it("fails when a member's field differs between the two", () => {
    const drifted = typeCheck(
      paritySource(
        'Exclude<SdkNotificationWiring, { kind: "file-notifier" }> | ' +
          '(Omit<Extract<SdkNotificationWiring, { kind: "file-notifier" }>, "payload"> & ' +
          '{ payload: "json-arg" })',
      ),
    );
    // A parity failure, not some unrelated compile error.
    expect(drifted).toContain("Type 'true' is not assignable to type 'false'.");
  }, 30_000);
});
