import { execFile } from "node:child_process";
import fs from "node:fs";
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import * as YAML from "yaml";
import type {
  RepoScanResult,
  SuggestedComponent,
  SuggestedTool,
  ComponentType,
} from "@roubo/shared";
import { parseConfig } from "./config-parser.js";
import { resolveWithin } from "../lib/safe-path.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "bin", "obj", "dist", "build", ".roubo"]);
const SCAN_TIMEOUT = 5000;
const MAX_DEPTH = 3;
const TYPE_OR_NAMESPACE_DECL =
  /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|file)\s+)*(?:namespace|class|struct|record|interface|enum|delegate)\b/;
const CLASS_PROGRAM = /\bclass\s+Program\b/;
const MAIN_METHOD =
  /\bstatic\s+(?:async\s+)?(?:void|int|Task\s*<\s*int\s*>|Task)\s+Main\s*\(\s*(?:string\s*\[\s*\]\s+\w+)?\s*\)/;

export async function scanRepo(repoPath: string): Promise<RepoScanResult> {
  const resolved = path.resolve(repoPath);

  const detected: RepoScanResult["detected"] = {
    hasGit: false,
    submodules: {},
    structureType: "single-repo",
    dockerComposeFiles: [],
    dockerComposeServiceNames: {},
    dockerComposePortVars: {},
    dockerComposeVars: {},
    dotnetProjects: [],
    solutionFiles: [],
    viteProjects: [],
    envFiles: [],
    webFrameworks: [],
    nativeFrameworks: [],
    suggestedName: suggestName(resolved),
    suggestedRepo: null,
    suggestedProjectType: null,
    suggestedComponents: [],
    suggestedTools: [],
  };

  detected.hasGit = fs.existsSync(resolveWithin(resolved, ".git"));

  if (detected.hasGit) {
    detected.suggestedRepo = await detectRepo(resolved);
  }

  const gitmodulesPath = resolveWithin(resolved, ".gitmodules");
  if (fs.existsSync(gitmodulesPath)) {
    detected.submodules = parseGitmodules(fs.readFileSync(gitmodulesPath, "utf-8"));
  }

  if (Object.keys(detected.submodules).length > 0) {
    detected.structureType = "meta-repo";
  } else {
    const rootPkgPath = resolveWithin(resolved, "package.json");
    if (fs.existsSync(rootPkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
        if (pkg.workspaces) {
          detected.structureType = "monorepo";
        }
        collectFrameworkSignals(pkg, detected);
      } catch {
        // invalid package.json, ignore
      }
    }
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), SCAN_TIMEOUT);

  try {
    await walk(resolved, 0, detected, abortController.signal);
  } catch {
    // timeout or error — return whatever we collected
  } finally {
    clearTimeout(timeout);
  }

  detected.suggestedProjectType = inferProjectType(detected);

  detected.dockerComposeFiles = detected.dockerComposeFiles.map((p) => path.relative(resolved, p));
  detected.dotnetProjects = detected.dotnetProjects.map((p) => path.relative(resolved, p));
  detected.solutionFiles = detected.solutionFiles.map((p) => path.relative(resolved, p));
  detected.viteProjects = detected.viteProjects.map((p) => path.relative(resolved, p));
  detected.envFiles = detected.envFiles.map((p) => path.relative(resolved, p));

  const suggestedComponents: SuggestedComponent[] = [];

  for (const composeFile of detected.dockerComposeFiles) {
    let abs: string;
    try {
      abs = resolveWithin(resolved, composeFile);
    } catch {
      continue;
    }
    const { suggestions, allServiceNames, portVars, composeVars } =
      await parseDockerComposeServices(abs, composeFile);
    suggestedComponents.push(...suggestions);
    detected.dockerComposeServiceNames[composeFile] = allServiceNames;
    detected.dockerComposePortVars[composeFile] = portVars;
    detected.dockerComposeVars[composeFile] = composeVars;
  }

  suggestedComponents.push(...inferDotnetServices(detected.dotnetProjects));
  suggestedComponents.push(...inferFrontendServices(detected.viteProjects));

  deduplicateServiceKeys(suggestedComponents);
  detected.suggestedComponents = suggestedComponents;
  detected.suggestedTools = inferTools(
    suggestedComponents,
    detected.solutionFiles,
    detected.suggestedProjectType,
    detected.viteProjects,
  );

  let existingConfig: RepoScanResult["existingConfig"] = null;
  const result = parseConfig(resolved);
  if (result.valid && result.config) {
    existingConfig = {
      path: ".roubo/roubo.yaml",
      config: result.config,
    };
  }

  return { detected, existingConfig };
}

async function walk(
  dir: string,
  depth: number,
  detected: RepoScanResult["detected"],
  signal: AbortSignal,
): Promise<void> {
  if (depth > MAX_DEPTH || signal.aborted) return;

  // `dir` is either the absolute repoPath (already resolved by scanRepo) or a
  // child path produced by resolveWithin below, so the value is always an
  // absolute, normalised path. We pass it straight to readdir/resolveWithin
  // without an extra path.resolve to avoid creating a fresh path expression
  // that CodeQL flags at the readdir sink.
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (signal.aborted) return;
    let fullPath: string;
    try {
      fullPath = resolveWithin(dir, entry.name);
    } catch {
      continue;
    }

    if (entry.isFile()) {
      if (entry.name === "docker-compose.yml" || entry.name === "docker-compose.yaml") {
        detected.dockerComposeFiles.push(fullPath);
      } else if (entry.name.endsWith(".csproj")) {
        if (await isRunnableProject(dir)) {
          detected.dotnetProjects.push(fullPath);
        }
      } else if (entry.name.endsWith(".sln")) {
        detected.solutionFiles.push(fullPath);
      } else if (entry.name === "pubspec.yaml") {
        if (!detected.nativeFrameworks.includes("flutter")) {
          detected.nativeFrameworks.push("flutter");
        }
      } else if (entry.name.startsWith(".env")) {
        detected.envFiles.push(fullPath);
      }
    } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      if (entry.name !== "." && entry.name !== "..") {
        const pkgPath = resolveWithin(fullPath, "package.json");
        try {
          await access(pkgPath);
          const pkgContent = await readFile(pkgPath, "utf-8");
          const pkg = JSON.parse(pkgContent);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.vite) {
            detected.viteProjects.push(fullPath);
          }
          collectFrameworkSignals(pkg, detected);
        } catch {
          // no package.json or invalid
        }
        await walk(fullPath, depth + 1, detected, signal);
      }
    }
  }
}

function parseGitmodules(content: string): Record<string, string> {
  const submodules: Record<string, string> = {};
  let currentName: string | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      currentName = sectionMatch[1];
      continue;
    }
    if (currentName && trimmed.startsWith("path")) {
      const value = trimmed.split("=")[1]?.trim();
      if (value) {
        submodules[currentName] = value;
      }
    }
  }

  return submodules;
}

const WEB_INDICATORS = [
  "vite",
  "next",
  "nuxt",
  "@angular/core",
  "svelte",
  "gatsby",
  "@remix-run/node",
  "astro",
];
const NATIVE_INDICATORS = ["react-native", "expo", "@expo/cli"];

function collectFrameworkSignals(
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  detected: RepoScanResult["detected"],
): void {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const indicator of WEB_INDICATORS) {
    if (deps[indicator] && !detected.webFrameworks.includes(indicator)) {
      detected.webFrameworks.push(indicator);
    }
  }
  for (const indicator of NATIVE_INDICATORS) {
    if (deps[indicator] && !detected.nativeFrameworks.includes(indicator)) {
      detected.nativeFrameworks.push(indicator);
    }
  }
}

export function inferProjectType(
  detected: RepoScanResult["detected"],
): "web" | "native" | "api-only" | null {
  const hasNative = detected.nativeFrameworks.length > 0;
  const hasWeb = detected.webFrameworks.length > 0;
  const hasBackend = detected.dotnetProjects.length > 0 || detected.dockerComposeFiles.length > 0;

  if (hasNative) return "native";
  if (hasWeb) return "web";
  if (hasBackend) return "api-only";
  return null;
}

function detectRepo(repoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, "remote", "get-url", "origin"], (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const url = stdout.trim();
      const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
      if (sshMatch) return resolve(sshMatch[1]);
      try {
        const parsed = new URL(url);
        const parts = parsed.pathname.replace(/\.git$/, "").replace(/^\//, "");
        if (parts.includes("/")) return resolve(parts);
      } catch {
        // not a valid URL
      }
      resolve(null);
    });
  });
}

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function suggestName(repoPath: string): string {
  return toSlug(path.basename(repoPath));
}

async function isRunnableProject(projectDir: string): Promise<boolean> {
  // Caller (walk) always passes an absolute path it derived from
  // resolveWithin or the resolved repo root, so no extra path.resolve.
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const csFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".cs"))
    .map((e) => e.name)
    .sort((a, b) => {
      // Check Program.cs first; most common entry point location.
      const aIsProg = a.toLowerCase() === "program.cs" ? 0 : 1;
      const bIsProg = b.toLowerCase() === "program.cs" ? 0 : 1;
      return aIsProg - bIsProg;
    });

  for (const name of csFiles) {
    let file: string;
    try {
      file = resolveWithin(projectDir, name);
    } catch {
      continue;
    }
    try {
      const content = await readFile(file, "utf-8");
      if (hasTopLevelStatements(content) || hasProgramMain(content)) {
        return true;
      }
    } catch {
      // unreadable; skip
    }
  }

  return false;
}

function hasTopLevelStatements(content: string): boolean {
  const lines = content.split("\n");
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }

    if (!trimmed) continue;
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("#")) continue;
    if (
      /^\s*(global\s+)?using\s+/.test(trimmed) &&
      !trimmed.startsWith("using (") &&
      !trimmed.startsWith("using var ")
    )
      continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) continue;

    // First meaningful line — if it's a type/namespace declaration, not top-level statements
    return !TYPE_OR_NAMESPACE_DECL.test(line);
  }

  return false;
}

function hasProgramMain(content: string): boolean {
  return CLASS_PROGRAM.test(content) && MAIN_METHOD.test(content);
}

const DB_IMAGE_PATTERNS: Array<{ pattern: RegExp; type: ComponentType }> = [
  { pattern: /mssql|sqlserver|sql-server/i, type: "database" },
  { pattern: /postgres/i, type: "database" },
  { pattern: /mysql|mariadb/i, type: "database" },
  { pattern: /redis/i, type: "database" },
  { pattern: /mongo/i, type: "database" },
];

interface ComposeSvc {
  image?: string;
  depends_on?: string[] | Record<string, unknown>;
  ports?: unknown[];
  restart?: string;
}

const INIT_NAME_PATTERN = /\b(?:init|migrate|seed|setup)\b/i;

function isInitService(name: string, svc: ComposeSvc, primaryName: string): boolean {
  const deps = svc.depends_on;
  const dependsOnPrimary = Array.isArray(deps)
    ? deps.includes(primaryName)
    : deps && typeof deps === "object" && primaryName in deps;

  if (!dependsOnPrimary) return false;

  const nameHint = INIT_NAME_PATTERN.test(name);
  const noPorts = !svc.ports || (Array.isArray(svc.ports) && svc.ports.length === 0);
  const ephemeralRestart = !svc.restart || svc.restart === "no" || svc.restart === "on-failure";

  return nameHint || noPorts || ephemeralRestart;
}

const COMPOSE_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)(?::-((?:[^}\\]|\\.)*))?\}/gi;

/**
 * Recursively walks all string values in a compose service definition and extracts
 * every `${VAR_NAME}` or `${VAR_NAME:-default}` variable reference.
 * Returns a map of varName → default value (or null if no default).
 */
export function extractComposeVars(obj: unknown): Record<string, string | null> {
  const vars: Record<string, string | null> = {};

  function walk(value: unknown): void {
    if (typeof value === "string") {
      for (const match of value.matchAll(COMPOSE_VAR_PATTERN)) {
        const name = match[1];
        const defaultVal = match[2] !== undefined ? match[2] : null;
        if (!(name in vars)) vars[name] = defaultVal;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  }

  walk(obj);
  return vars;
}

/** Extracts the first `${VAR_NAME}` or `${VAR_NAME:-default}` variable from a compose port string. */
export function extractPortVar(portValue: unknown): string | null {
  if (typeof portValue !== "string") return null;
  const match = COMPOSE_VAR_PATTERN.exec(portValue);
  COMPOSE_VAR_PATTERN.lastIndex = 0;
  if (!match) return null;
  // Only return the var if it appears on the host side (before the last colon separator)
  const parts = portValue.split(":");
  const hostPart = parts.length >= 2 ? parts.slice(0, -1).join(":") : portValue;
  COMPOSE_VAR_PATTERN.lastIndex = 0;
  const hostMatch = COMPOSE_VAR_PATTERN.exec(hostPart);
  COMPOSE_VAR_PATTERN.lastIndex = 0;
  return hostMatch ? hostMatch[1] : null;
}

async function parseDockerComposeServices(
  absolutePath: string,
  relativePath: string,
): Promise<{
  suggestions: SuggestedComponent[];
  allServiceNames: string[];
  portVars: Record<string, string | null>;
  composeVars: Record<string, Record<string, string | null>>;
}> {
  try {
    const content = await readFile(absolutePath, "utf-8");
    const doc = YAML.parse(content) as Record<string, unknown> | null;
    if (!doc || typeof doc !== "object")
      return { suggestions: [], allServiceNames: [], portVars: {}, composeVars: {} };

    const services = (doc.services ?? doc) as Record<string, ComposeSvc> | undefined;
    if (!services || typeof services !== "object")
      return { suggestions: [], allServiceNames: [], portVars: {}, composeVars: {} };

    const allServiceNames = Object.keys(services);

    // Extract all compose variables for each service and port variable specifically
    const portVars: Record<string, string | null> = {};
    const composeVars: Record<string, Record<string, string | null>> = {};
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== "object") continue;
      const ports = svc.ports;
      if (!Array.isArray(ports) || ports.length === 0) {
        portVars[name] = null;
      } else {
        const detected = ports.map((p) => extractPortVar(p)).find((v) => v !== null) ?? null;
        portVars[name] = detected;
      }
      composeVars[name] = extractComposeVars(svc);
    }

    const dbServices: Array<{ name: string; svc: ComposeSvc; type: ComponentType }> = [];
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== "object" || !svc.image) continue;
      const image = String(svc.image);
      for (const { pattern, type } of DB_IMAGE_PATTERNS) {
        if (pattern.test(image)) {
          dbServices.push({ name, svc, type });
          break;
        }
      }
    }

    const initFor = new Map<string, string>();
    for (const candidate of dbServices) {
      for (const primary of dbServices) {
        if (candidate.name === primary.name) continue;
        if (candidate.type !== primary.type) continue;
        if (isInitService(candidate.name, candidate.svc, primary.name)) {
          initFor.set(candidate.name, primary.name);
          break;
        }
      }
    }

    const suggestions: SuggestedComponent[] = [];
    for (const { name, type } of dbServices) {
      if (initFor.has(name)) continue; // skip — will be attached as initService

      const initServiceName = [...initFor.entries()].find(([, primary]) => primary === name)?.[0];

      const portEnvVar = portVars[name] ?? undefined;
      // Merge init service vars first, then primary service vars (primary takes precedence)
      const initVars = initServiceName ? (composeVars[initServiceName] ?? {}) : {};
      const detectedVars = { ...initVars, ...(composeVars[name] ?? {}) };
      const env: Record<string, string> = {};
      for (const [varName, defaultVal] of Object.entries(detectedVars)) {
        env[varName] = defaultVal ?? "";
      }

      suggestions.push({
        key: name,
        config: {
          type,
          docker: {
            composeFile: relativePath,
            service: name,
            ...(initServiceName ? { initService: initServiceName } : {}),
            ...(portEnvVar ? { portEnvVar } : {}),
          },
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
        source: relativePath,
      });
    }

    return { suggestions, allServiceNames, portVars, composeVars };
  } catch {
    return { suggestions: [], allServiceNames: [], portVars: {}, composeVars: {} };
  }
}

const TEST_PROJECT_PATTERN = /[._-]?(?:tests?|specs?)(?:[._-]|$)/i;

function inferDotnetServices(dotnetProjects: string[]): SuggestedComponent[] {
  const filtered = dotnetProjects.filter(
    (p) => !TEST_PROJECT_PATTERN.test(path.basename(p, ".csproj")),
  );
  if (filtered.length === 0) return [];

  if (filtered.length === 1) {
    return [
      {
        key: "backend",
        config: { type: "process", command: `dotnet run --project ${filtered[0]}` },
        source: filtered[0],
      },
    ];
  }

  return filtered.map((p) => {
    const dirName = path.basename(path.dirname(p));
    const key = toSlug(dirName) || "backend";
    return {
      key,
      config: { type: "process", command: `dotnet run --project ${p}` },
      source: p,
    };
  });
}

function inferFrontendServices(viteProjects: string[]): SuggestedComponent[] {
  if (viteProjects.length === 0) return [];

  if (viteProjects.length === 1) {
    return [
      {
        key: "frontend",
        config: {
          type: "process",
          command: "npm run dev",
          directory: viteProjects[0],
          setup: "npm install",
        },
        source: viteProjects[0],
      },
    ];
  }

  return viteProjects.map((p) => {
    const dirName = path.basename(p);
    const key = toSlug(dirName) || "frontend";
    return {
      key,
      config: { type: "process", command: "npm run dev", directory: p, setup: "npm install" },
      source: p,
    };
  });
}

function deduplicateServiceKeys(components: SuggestedComponent[]): void {
  const seen = new Map<string, number>();
  for (const component of components) {
    const baseKey = component.key;
    const count = seen.get(baseKey) ?? 0;
    if (count > 0) {
      component.key = `${baseKey}-${count + 1}`;
    }
    seen.set(baseKey, count + 1);
  }
}

function inferTools(
  suggestedComponents: SuggestedComponent[],
  solutionFiles: string[],
  suggestedProjectType: "web" | "native" | "api-only" | null,
  viteProjects: string[],
): SuggestedTool[] {
  const tools: SuggestedTool[] = [];
  // All components are now type "process", so we identify vite-based ones by matching against
  // the source field set by inferFrontendServices rather than by component type.
  const viteProjectSet = new Set(viteProjects);
  const viteComponents = suggestedComponents.filter((s) => viteProjectSet.has(s.source));
  const multiVite = viteComponents.length > 1;

  for (const component of viteComponents) {
    tools.push({
      config: {
        name: multiVite ? `Web App (${component.key})` : "Web App",
        icon: "globe",
        type: "browser",
        url: `{{urls.${component.key}}}`,
        requires: component.key,
      },
      source: `vite:${component.key}`,
    });
  }

  for (const component of viteComponents) {
    const dir = component.config.directory;
    if (!dir || dir === ".") continue;
    tools.push({
      config: {
        name: multiVite ? `VS Code (${component.key})` : "VS Code",
        icon: "code",
        type: "shell",
        command: `code "{{workspace}}/${dir}"`,
      },
      source: `vscode:${component.key}`,
    });
  }

  if (suggestedProjectType === "web") {
    tools.push({
      config: {
        name: viteComponents.some((s) => s.config.directory && s.config.directory !== ".")
          ? "VS Code (root)"
          : "VS Code",
        icon: "code",
        type: "shell",
        command: 'code "{{workspace}}"',
      },
      source: "vscode:root",
    });
  }

  const multiSln = solutionFiles.length > 1;
  for (const slnPath of solutionFiles) {
    const slnName = path.basename(slnPath);
    tools.push({
      config: {
        name: multiSln ? `Rider (${slnName})` : "Rider",
        icon: "code",
        type: "shell",
        command: `open -a "Rider" "{{workspace}}/${slnPath}"`,
      },
      source: `rider:${slnPath}`,
    });
  }

  return tools;
}
