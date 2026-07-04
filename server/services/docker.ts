import path from "node:path";
import Dockerode from "dockerode";
import { runCommand } from "./exec.js";

const docker = new Dockerode();

export interface DockerStartOptions {
  composeFile: string;
  service: string;
  projectName: string;
  portOverrides: Record<string, string>; // env vars for docker-compose interpolation, e.g. { "HOST_PORT": "1434" }
  cwd: string;
}

export async function composeUp(
  opts: DockerStartOptions,
): Promise<{ success: boolean; error?: string; stdout: string; stderr: string }> {
  const composeDir = path.dirname(path.resolve(opts.cwd, opts.composeFile));
  const composeFileName = path.basename(opts.composeFile);

  const args = ["compose", "-f", composeFileName, "-p", opts.projectName, "up", "-d", opts.service];

  const result = await runCommand("docker", args, composeDir, { ...opts.portOverrides });

  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr || result.stdout,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return { success: true, stdout: result.stdout, stderr: result.stderr };
}

export async function composeStop(
  projectName: string,
  composeFile: string,
  cwd: string,
  service?: string,
): Promise<void> {
  const composeDir = path.dirname(path.resolve(cwd, composeFile));
  const composeFileName = path.basename(composeFile);

  // Omit the service arg entirely when none is given: `docker compose stop`
  // with no service stops the whole project, whereas passing an empty-string
  // positional arg would be treated as a service filter matching nothing.
  const args = ["compose", "-f", composeFileName, "-p", projectName, "stop"];
  if (service) args.push(service);

  await runCommand("docker", args, composeDir);
}

export async function composeDown(
  projectName: string,
  composeFile: string,
  cwd: string,
): Promise<void> {
  const composeDir = path.dirname(path.resolve(cwd, composeFile));
  const composeFileName = path.basename(composeFile);

  await runCommand(
    "docker",
    ["compose", "-f", composeFileName, "-p", projectName, "down", "-v"],
    composeDir,
  );
}

/**
 * Tears a compose project down by project name alone, without a compose file
 * (issue #613). `docker compose -p <name> down -v` resolves the project from the
 * `com.docker.compose.project` label Docker stamped on every container at
 * `composeUp`, so the original compose file is not needed. This is what the
 * startup orphan sweep uses to reap an escaped `roubo-<projectId>-bench-<N>`
 * project after a hard host kill, where the host no longer holds the compose
 * file path the regular `composeDown` requires. Runs from `process.cwd()`: the
 * directory is irrelevant when the project is selected by name.
 */
export async function composeDownByProject(projectName: string): Promise<void> {
  await runCommand("docker", ["compose", "-p", projectName, "down", "-v"], process.cwd());
}

export async function composeRunInit(opts: {
  composeFile: string;
  initService: string;
  projectName: string;
  portOverrides: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
}): Promise<{ success: boolean; error?: string; stdout: string; stderr: string }> {
  const composeDir = path.dirname(path.resolve(opts.cwd, opts.composeFile));
  const composeFileName = path.basename(opts.composeFile);

  const args = [
    "compose",
    "-f",
    composeFileName,
    "-p",
    opts.projectName,
    "run",
    "--rm",
    opts.initService,
  ];

  const result = await runCommand(
    "docker",
    args,
    composeDir,
    { ...opts.portOverrides },
    opts.timeoutMs,
  );

  if (result.code !== 0) {
    return {
      success: false,
      error: `Init service failed: ${result.stderr || result.stdout}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return { success: true, stdout: result.stdout, stderr: result.stderr };
}

function classifyRunningContainer(status: string): ContainerStatus {
  if (status.includes("(unhealthy)")) return "unhealthy";
  if (status.includes("(health") && !status.includes("(healthy)")) return "starting";
  return "running";
}

export async function getContainerStatus(
  projectName: string,
  service: string,
): Promise<ContainerStatus> {
  try {
    const containers = await docker.listContainers({ all: true });
    const match = containers.find(
      (c) =>
        c.Labels?.["com.docker.compose.project"] === projectName &&
        c.Labels?.["com.docker.compose.service"] === service,
    );
    if (!match) return "not_found";
    if (match.State === "running") {
      return classifyRunningContainer(match.Status);
    }
    return "stopped";
  } catch {
    return "not_found";
  }
}

export type ContainerStatus = "running" | "starting" | "stopped" | "not_found" | "unhealthy";

/**
 * A batched container-status entry: the classified status plus the resolved
 * container id (null when no container matched the query). The id lets callers
 * populate `ComponentStatus.containerId` from the same single listContainers
 * call, so the reconcile / refresh paths surface the id without a second docker
 * round-trip (davidpoxon/roubo-development#410).
 */
export interface ContainerStatusResult {
  status: ContainerStatus;
  id: string | null;
}

export async function getContainerStatuses(
  queries: Array<{ projectName: string; service: string }>,
): Promise<Map<string, ContainerStatusResult>> {
  const results = new Map<string, ContainerStatusResult>();
  try {
    const containers = await docker.listContainers({ all: true });
    for (const q of queries) {
      const key = `${q.projectName}/${q.service}`;
      const match = containers.find(
        (c) =>
          c.Labels?.["com.docker.compose.project"] === q.projectName &&
          c.Labels?.["com.docker.compose.service"] === q.service,
      );
      if (!match) {
        results.set(key, { status: "not_found", id: null });
        continue;
      }
      if (match.State === "running") {
        results.set(key, { status: classifyRunningContainer(match.Status), id: match.Id });
      } else {
        results.set(key, { status: "stopped", id: match.Id });
      }
    }
  } catch {
    for (const q of queries)
      results.set(`${q.projectName}/${q.service}`, { status: "not_found", id: null });
  }
  return results;
}

// Default timeout is 300s to accommodate slow-starting services (e.g. database migrations, seeding).
// Containers without a health check resolve immediately as 'running', so this only gates containers
// with a configured health check. Unhealthy containers exit early via the status check below.
export async function waitForHealthy(
  projectName: string,
  service: string,
  timeoutMs = 300_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getContainerStatus(projectName, service);
    if (status === "running") return true;
    if (status === "stopped" || status === "not_found" || status === "unhealthy") return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

const DB_IMAGE_PATTERNS: Array<{ pattern: RegExp; defaultPort: number }> = [
  { pattern: /mssql|sqlserver|sql-server/i, defaultPort: 1433 },
  { pattern: /postgres/i, defaultPort: 5432 },
  { pattern: /mysql|mariadb/i, defaultPort: 3306 },
  { pattern: /redis/i, defaultPort: 6379 },
  { pattern: /mongo/i, defaultPort: 27017 },
];

export async function listDatabaseContainers(): Promise<
  Array<{
    id: string;
    name: string;
    image: string;
    port?: number;
    status: string;
  }>
> {
  try {
    const containers = await docker.listContainers({ all: true });
    return containers.flatMap((c) => {
      const match = DB_IMAGE_PATTERNS.find((p) => p.pattern.test(c.Image));
      if (!match) return [];
      return [
        {
          id: c.Id.slice(0, 12),
          name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
          image: c.Image,
          port: c.Ports.find((p) => p.PrivatePort === match.defaultPort)?.PublicPort,
          status: c.State,
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function getContainerStatusById(containerId: string): Promise<ContainerStatus> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    if (!info.State.Running) return "stopped";
    const health = info.State.Health?.Status;
    if (health === "unhealthy") return "unhealthy";
    if (health && health !== "healthy") return "starting";
    return "running";
  } catch {
    return "not_found";
  }
}

/**
 * Resolve identity + published port for ANY container by id, independent of its
 * image type. Replaces the database-image-pattern lookup (`listDatabaseContainers`)
 * in the assign-container path so core carries no docker-image/component-type
 * knowledge there (#612, NFR-006): the host validates the assigned container
 * exists and exposes a port, and the bound plugin (via its `assignedContainerId`
 * descriptor) owns the type-specific adoption. Returns null when no container by
 * that id exists.
 */
export async function getContainerInfoById(containerId: string): Promise<{
  id: string;
  name: string;
  port?: number;
  status: string;
} | null> {
  try {
    const containers = await docker.listContainers({ all: true });
    const match = containers.find((c) => c.Id === containerId || c.Id.slice(0, 12) === containerId);
    if (!match) return null;
    return {
      id: match.Id.slice(0, 12),
      name: match.Names[0]?.replace(/^\//, "") ?? match.Id.slice(0, 12),
      port: match.Ports.find((p) => p.PublicPort)?.PublicPort,
      status: match.State,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the container ID for a compose service in a project, or null when no
 * matching container exists. Used by the broker to report `composeUp`'s
 * containerId, which `composeUp` itself does not return (it returns only
 * stdout/stderr/success).
 */
export async function getContainerId(projectName: string, service: string): Promise<string | null> {
  try {
    const containers = await docker.listContainers({ all: true });
    const match = containers.find(
      (c) =>
        c.Labels?.["com.docker.compose.project"] === projectName &&
        c.Labels?.["com.docker.compose.service"] === service,
    );
    return match ? match.Id : null;
  } catch {
    return null;
  }
}

export function getComposeProjectName(projectId: string, benchNumber: number): string {
  return `roubo-${projectId}-bench-${benchNumber}`;
}
