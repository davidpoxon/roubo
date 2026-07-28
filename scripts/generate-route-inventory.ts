// generate:routes pipeline.
//
// Extracts the Express route inventory from server/index.ts plus every router
// under server/routes/ and writes docs/routes.md. The checked-in output is the
// artifact humans read; the CI drift guard (the route-inventory-drift job in
// pr-check.yml) re-runs this script and `git diff --exit-code`s docs/routes.md,
// so the inventory cannot silently fall behind the handlers (#1018).
//
// Three decisions worth stating, because each has a tempting wrong answer:
//
// 1. Plain inventory, not OpenAPI. The issue left the format open. Request and
//    response shapes live only in shared/types.ts and the handlers, so an
//    OpenAPI document would need hand-authored content, which is exactly the
//    drift this generator exists to kill. Method, path and source file are all
//    derivable, so they are all we emit.
//
// 2. Static parse, not runtime introspection of router.stack. Importing the
//    route modules pulls services/ in at load time and booting the app has real
//    side effects (loadEnvFile, migrate.run, a WebSocket server). A static parse
//    is hermetic and safe to run in CI. Verified there is no dynamic route
//    registration: plugin-route-helpers.ts holds response helpers only and
//    plugin-manager.ts registers nothing, so the static view is complete.
//
// 3. No curation. Every extracted handler is emitted, including the env-gated
//    /test router and the SPA catch-all. A hand-maintained skip list would be
//    the same class of drift the inventory removes.
//
// The TypeScript compiler API does the parsing because 13 handlers use the
// multi-line `router.get(\n  "/path",` form, which a line-based regex misses.
//
// Run with: npm run generate:routes  (executes via tsx, the repo's TS runner)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import prettier from "prettier";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
export const outPath = resolve(repoRoot, "docs", "routes.md");

export const INDEX_SOURCE = "server/index.ts";
export const ROUTES_DIR = "server/routes";

// Express verb methods we treat as route registrations. `use` is deliberately
// absent: the three `router.use(...)` calls in the tree attach middleware and
// carry no path, so they register no route.
export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
] as const;

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

export interface RouteEntry {
  /** Uppercased HTTP method, or ALL for `router.all`. */
  method: string;
  /** Fully joined path, mount prefix included. */
  path: string;
  /** Repo-relative file the handler is declared in. */
  source: string;
}

export interface RouterMount {
  /** The prefix passed to `app.use`. */
  mountPath: string;
  /** Repo-relative path of the router module mounted there. */
  source: string;
}

export interface IndexRegistrations {
  mounts: RouterMount[];
  /** Handlers registered straight onto `app` in server/index.ts. */
  inlineRoutes: RouteEntry[];
}

function parseSource(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function lineOf(node: ts.Node): number {
  const file = node.getSourceFile();
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** The literal text of a path argument, or undefined when it is not a literal. */
function literalPath(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * The verb of a `<receiver>.<verb>(...)` call, or undefined when the call is
 * not a route registration on the given receiver.
 */
function verbOf(node: ts.Node, receiver: string): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== receiver) return undefined;
  const verb = callee.name.text;
  return HTTP_METHOD_SET.has(verb) ? verb : undefined;
}

/** Join a mount prefix and a handler path into the path a client calls. */
export function joinRoutePath(mountPath: string, handlerPath: string): string {
  if (mountPath === "") return handlerPath;
  if (handlerPath === "/" || handlerPath === "") return mountPath;
  return `${mountPath}${handlerPath}`;
}

/**
 * Read server/index.ts and return both the router mount table and any handler
 * registered directly on `app`.
 *
 * Throws rather than under-reporting: a non-literal path argument means the
 * inventory would be silently incomplete, which defeats the drift guard.
 */
export function collectIndexRegistrations(indexText: string): IndexRegistrations {
  const file = parseSource(indexText, INDEX_SOURCE);

  // Default imports from ./routes/<name>.js, so `app.use(prefix, ident)` can be
  // resolved back to the module the handlers live in.
  const routerModules = new Map<string, string>();
  walk(file, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const specifier = literalPath(node.moduleSpecifier);
    const match = specifier?.match(/^\.\/routes\/(.+)\.js$/);
    const defaultImport = node.importClause?.name;
    if (!match || !defaultImport) return;
    routerModules.set(defaultImport.text, `${ROUTES_DIR}/${match[1]}.ts`);
  });

  const mounts: RouterMount[] = [];
  const inlineRoutes: RouteEntry[] = [];

  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "app") return;

    if (callee.name.text === "use") {
      const mounted = node.arguments[1];
      if (!mounted || !ts.isIdentifier(mounted)) return;
      const source = routerModules.get(mounted.text);
      if (!source) return;
      const mountPath = literalPath(node.arguments[0]);
      if (mountPath === undefined) {
        throw new Error(
          `${INDEX_SOURCE}:${lineOf(node)}: app.use mounts ${mounted.text} at a non-literal path; the route inventory cannot be derived statically.`,
        );
      }
      mounts.push({ mountPath, source });
      return;
    }

    const verb = verbOf(node, "app");
    if (!verb) return;
    const handlerPath = literalPath(node.arguments[0]);
    if (handlerPath === undefined) {
      throw new Error(
        `${INDEX_SOURCE}:${lineOf(node)}: app.${verb} uses a non-literal path; the route inventory cannot be derived statically.`,
      );
    }
    inlineRoutes.push({ method: verb.toUpperCase(), path: handlerPath, source: INDEX_SOURCE });
  });

  return { mounts, inlineRoutes };
}

/** Every `router.<verb>("<path>", ...)` registration in one router module. */
export function collectHandlers(
  moduleText: string,
  source: string,
): { method: string; handlerPath: string }[] {
  const file = parseSource(moduleText, source);
  const handlers: { method: string; handlerPath: string }[] = [];

  walk(file, (node) => {
    const verb = verbOf(node, "router");
    if (!verb || !ts.isCallExpression(node)) return;
    const handlerPath = literalPath(node.arguments[0]);
    if (handlerPath === undefined) {
      throw new Error(
        `${source}:${lineOf(node)}: router.${verb} uses a non-literal path; the route inventory cannot be derived statically.`,
      );
    }
    handlers.push({ method: verb.toUpperCase(), handlerPath });
  });

  return handlers;
}

/** Route modules under server/routes/, excluding test files. */
export function listRouteModules(): string[] {
  return readdirSync(resolve(repoRoot, ROUTES_DIR))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => `${ROUTES_DIR}/${name}`);
}

export interface RouterModule {
  source: string;
  handlers: { method: string; handlerPath: string }[];
}

/**
 * Cross the mount table with the per-module handlers. Kept pure and separate
 * from disk reads so the unmounted-router guard is directly testable.
 *
 * Sorted by path then method so the artifact is stable under handler
 * reordering inside a file.
 */
export function assembleRoutes(
  { mounts, inlineRoutes }: IndexRegistrations,
  modules: RouterModule[],
): RouteEntry[] {
  const routes: RouteEntry[] = [...inlineRoutes];
  const mountedSources = new Set(mounts.map((mount) => mount.source));

  for (const { source, handlers } of modules) {
    if (handlers.length === 0) continue;
    if (!mountedSources.has(source)) {
      throw new Error(
        `${source} declares ${handlers.length} route handler(s) but is never mounted in ${INDEX_SOURCE}; the route inventory would omit them.`,
      );
    }
    // A module can be mounted more than once, and 12 of them share /api/projects.
    for (const mount of mounts.filter((candidate) => candidate.source === source)) {
      for (const { method, handlerPath } of handlers) {
        routes.push({ method, path: joinRoutePath(mount.mountPath, handlerPath), source });
      }
    }
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** The full inventory, read from the working tree. */
export function collectRoutes(): RouteEntry[] {
  const registrations = collectIndexRegistrations(
    readFileSync(resolve(repoRoot, INDEX_SOURCE), "utf8"),
  );
  const modules = listRouteModules().map((source) => ({
    source,
    handlers: collectHandlers(readFileSync(resolve(repoRoot, source), "utf8"), source),
  }));
  return assembleRoutes(registrations, modules);
}

/**
 * Render the inventory to markdown. Kept pure (no IO) so the unit tests can
 * assert byte-stability against the committed file without writing it.
 */
export function renderMarkdown(routes: RouteEntry[]): string {
  const lines = [
    "<!-- Generated by `npm run generate:routes`. Do not edit by hand. -->",
    "",
    "# Route inventory",
    "",
    `Every HTTP route the Roubo server registers: ${routes.length} in total, extracted from the router mount table in [\`server/index.ts\`](../server/index.ts) and the handlers under [\`server/routes/\`](../server/routes/).`,
    "",
    "This file is generated. Run `npm run generate:routes` after adding, removing, or renaming a route; the `route-inventory-drift` job in `pr-check` fails when the committed inventory does not match the source.",
    "",
    "Two entries need context. The `/test/*` routes come from an e2e-only router that responds 404 unless `ROUBO_E2E=1`, and `GET /{*path}` is the SPA fallback that serves the client for any non-`/api` path. Both are listed because the inventory is uncurated by design.",
    "",
    "Request and response shapes are not derivable from the route registrations, so they are not listed here. [docs/api.md](./api.md) documents the integration surface, and the TypeScript interfaces in [`shared/types.ts`](../shared/types.ts) are the contract.",
    "",
    "| Method | Path | Source |",
    "| ------ | ---- | ------ |",
    ...routes.map((route) => `| ${route.method} | \`${route.path}\` | \`${route.source}\` |`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Render the exact bytes we commit. Formatted with the repo's own prettier
 * config so the artifact satisfies `format:check` AND reproduces itself
 * byte-for-byte; prettier realigns markdown table pipes, so without this the
 * drift guard would fire on every run.
 */
export async function renderInventory(): Promise<string> {
  const prettierOptions = await prettier.resolveConfig(outPath);
  return prettier.format(renderMarkdown(collectRoutes()), {
    ...prettierOptions,
    parser: "markdown",
  });
}

export async function generate(): Promise<void> {
  writeFileSync(outPath, await renderInventory());
  console.log(`Wrote ${outPath}`);
}

// Run the pipeline only when executed directly (npm run generate:routes),
// never on import: importing this module from a test must not write files.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate();
}
