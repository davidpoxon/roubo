import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Dirent } from "node:fs";
import type { RouboConfig, RegisteredProject, Bench, PersistedBench } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";

export function makeConfig(overrides?: Partial<RouboConfig>): RouboConfig {
  return {
    project: {
      name: "test-project",
      displayName: "Test Project",
      type: "web",
      repo: "org/test-project",
    },
    layout: { type: "single-repo" },
    components: {
      backend: { type: "process", command: "dotnet run --project src/Api/Api.csproj" },
    },
    ports: {
      backend: { base: 5000 },
    },
    benches: { max: 5 },
    ...overrides,
  };
}

export function makeProject(overrides?: Partial<RegisteredProject>): RegisteredProject {
  return {
    id: "test-project",
    repoPath: "/repos/test-project",
    config: makeConfig(),
    configValid: true,
    settings: DEFAULT_PROJECT_SETTINGS,
    ...overrides,
  };
}

export function makeBench(overrides?: Partial<Bench>): Bench {
  return {
    id: 1,
    projectId: "test-project",
    branch: "bench-1",
    workspacePath: "/home/.roubo/workspaces/test-project/bench-1",
    status: "idle",
    ports: { backend: 5000 },
    components: {
      backend: { name: "backend", status: "stopped", setupComplete: true },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    ...overrides,
  };
}

export function makePersistedBench(overrides?: Partial<PersistedBench>): PersistedBench {
  return {
    id: 1,
    projectId: "test-project",
    branch: "bench-1",
    workspacePath: "/home/.roubo/workspaces/test-project/bench-1",
    ports: { backend: 5000 },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeDirent(name: string, isFile: boolean): Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  } as Dirent;
}

export function createMockChild(pid = 1234): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdin = null as any;
  proc.stdio = [null, proc.stdout, proc.stderr, null, null] as any;
  proc.pid = pid;
  proc.killed = false;
  proc.connected = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.spawnargs = [];
  proc.spawnfile = "";
  proc.kill = vi.fn();
  proc.send = vi.fn();
  proc.disconnect = vi.fn();
  proc.unref = vi.fn();
  proc.ref = vi.fn();
  proc[Symbol.dispose] = vi.fn();
  return proc;
}
