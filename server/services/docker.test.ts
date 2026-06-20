import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListContainers = vi.hoisted(() => vi.fn());
const mockInspect = vi.hoisted(() => vi.fn());
vi.mock("dockerode", () => {
  return {
    default: class MockDockerode {
      listContainers = mockListContainers;
      getContainer = () => ({ inspect: mockInspect });
    },
  };
});

vi.mock("./exec.js", () => ({
  runCommand: vi.fn(),
}));

import {
  composeUp,
  composeRunInit,
  composeStop,
  composeDown,
  getContainerStatus,
  getContainerStatuses,
  getContainerStatusById,
  waitForHealthy,
  listDatabaseContainers,
  getComposeProjectName,
  getContainerId,
} from "./docker.js";
import { runCommand } from "./exec.js";

const mockRunCommand = vi.mocked(runCommand);

beforeEach(() => {
  mockListContainers.mockReset();
  mockRunCommand.mockReset();
});

describe("getComposeProjectName", () => {
  it("returns roubo-{projectId}-bench-{n}", () => {
    expect(getComposeProjectName("project", 1)).toBe("roubo-project-bench-1");
    expect(getComposeProjectName("frontend", 3)).toBe("roubo-frontend-bench-3");
  });
});

describe("composeUp", () => {
  const baseOpts = {
    composeFile: "docker-compose.yml",
    service: "db",
    projectName: "roubo-project-bench-1",
    portOverrides: {},
    cwd: "/repo",
  };

  it("calls runCommand with correct docker compose args", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "started", stderr: "" });

    const result = await composeUp(baseOpts);

    expect(mockRunCommand).toHaveBeenCalledWith(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-p", "roubo-project-bench-1", "up", "-d", "db"],
      "/repo",
      {},
    );
    expect(result).toEqual({ success: true, stdout: "started", stderr: "" });
  });

  it("passes port override env vars", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeUp({ ...baseOpts, portOverrides: { "1433": "1434", "5432": "5433" } });

    expect(mockRunCommand).toHaveBeenCalledWith("docker", expect.any(Array), "/repo", {
      1433: "1434",
      5432: "5433",
    });
  });

  it("returns success:false when runCommand returns non-zero", async () => {
    mockRunCommand.mockResolvedValue({ code: 1, stdout: "", stderr: "compose failed" });

    const result = await composeUp(baseOpts);

    expect(result).toEqual({
      success: false,
      error: "compose failed",
      stdout: "",
      stderr: "compose failed",
    });
  });

  it("does not run init service", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeUp(baseOpts);

    expect(mockRunCommand).toHaveBeenCalledTimes(1);
  });
});

describe("composeStop", () => {
  it("calls runCommand with stop <service> args", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeStop("roubo-project-bench-1", "docker-compose.yml", "/repo", "db");

    expect(mockRunCommand).toHaveBeenCalledWith(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-p", "roubo-project-bench-1", "stop", "db"],
      "/repo",
    );
  });

  it("omits the service arg when none is given so the whole project stops", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeStop("roubo-project-bench-1", "docker-compose.yml", "/repo");

    expect(mockRunCommand).toHaveBeenCalledWith(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-p", "roubo-project-bench-1", "stop"],
      "/repo",
    );
  });
});

describe("composeDown", () => {
  it("calls runCommand with down -v args", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeDown("roubo-project-bench-1", "docker-compose.yml", "/repo");

    expect(mockRunCommand).toHaveBeenCalledWith(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-p", "roubo-project-bench-1", "down", "-v"],
      "/repo",
    );
  });
});

describe("composeRunInit", () => {
  const baseOpts = {
    composeFile: "docker-compose.yml",
    initService: "db-init",
    projectName: "roubo-project-bench-1",
    portOverrides: {},
    cwd: "/repo",
  };

  it("calls runCommand with correct docker compose run args", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeRunInit(baseOpts);

    expect(mockRunCommand).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "-f",
        "docker-compose.yml",
        "-p",
        "roubo-project-bench-1",
        "run",
        "--rm",
        "db-init",
      ],
      "/repo",
      {},
      undefined,
    );
  });

  it("passes port override env vars", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeRunInit({ ...baseOpts, portOverrides: { HOST_PORT: "1434" } });

    expect(mockRunCommand).toHaveBeenCalledWith(
      "docker",
      expect.any(Array),
      "/repo",
      { HOST_PORT: "1434" },
      undefined,
    );
  });

  it("passes timeoutMs to runCommand", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await composeRunInit({ ...baseOpts, timeoutMs: 60000 });

    expect(mockRunCommand).toHaveBeenCalledWith("docker", expect.any(Array), "/repo", {}, 60000);
  });

  it("returns success when init service succeeds", async () => {
    mockRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const result = await composeRunInit(baseOpts);

    expect(result).toEqual({ success: true, stdout: "", stderr: "" });
  });

  it("returns failure when init service fails", async () => {
    mockRunCommand.mockResolvedValue({ code: 1, stdout: "", stderr: "init failed" });

    const result = await composeRunInit(baseOpts);

    expect(result).toEqual({
      success: false,
      error: "Init service failed: init failed",
      stdout: "",
      stderr: "init failed",
    });
  });
});

describe("getContainerStatus", () => {
  it("returns 'running' for matching running container", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes",
      },
    ]);

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("running");
  });

  it("returns 'starting' for running container with pending healthcheck", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 3 seconds (health: starting)",
      },
    ]);

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("starting");
  });

  it("returns 'running' for running container with healthy healthcheck", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes (healthy)",
      },
    ]);

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("running");
  });

  it("returns 'stopped' for non-running container", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "exited",
        Status: "Exited (0) 5 minutes ago",
      },
    ]);

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("stopped");
  });

  it("returns 'not_found' when no match", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "other-project",
          "com.docker.compose.service": "web",
        },
        State: "running",
      },
    ]);

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("not_found");
  });

  it("returns 'unhealthy' for running container with failed healthcheck", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes (unhealthy)",
      },
    ]);

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("unhealthy");
  });

  it("returns 'not_found' on error", async () => {
    mockListContainers.mockRejectedValue(new Error("Docker not available"));

    const status = await getContainerStatus("roubo-project-bench-1", "db");
    expect(status).toBe("not_found");
  });
});

describe("getContainerStatuses", () => {
  it("returns statuses for multiple queries in a single call", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "proj-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes (healthy)",
      },
      {
        Labels: {
          "com.docker.compose.project": "proj-2",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 3 seconds (health: starting)",
      },
    ]);

    const results = await getContainerStatuses([
      { projectName: "proj-1", service: "db" },
      { projectName: "proj-2", service: "db" },
      { projectName: "proj-3", service: "db" },
    ]);

    expect(results.get("proj-1/db")).toBe("running");
    expect(results.get("proj-2/db")).toBe("starting");
    expect(results.get("proj-3/db")).toBe("not_found");
  });

  it("returns 'unhealthy' for unhealthy containers", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "proj-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes (unhealthy)",
      },
    ]);

    const results = await getContainerStatuses([{ projectName: "proj-1", service: "db" }]);

    expect(results.get("proj-1/db")).toBe("unhealthy");
  });
});

describe("listDatabaseContainers", () => {
  it("filters by DB image patterns", async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: "abc123456789def",
        Names: ["/my-postgres"],
        Image: "postgres:15",
        Ports: [{ PrivatePort: 5432, PublicPort: 5433 }],
        State: "running",
      },
      {
        Id: "def456789012ghi",
        Names: ["/my-redis"],
        Image: "redis:7",
        Ports: [{ PrivatePort: 6379, PublicPort: 6380 }],
        State: "running",
      },
      {
        Id: "ghi789012345jkl",
        Names: ["/my-nginx"],
        Image: "nginx:latest",
        Ports: [{ PrivatePort: 80, PublicPort: 8080 }],
        State: "running",
      },
    ]);

    const result = await listDatabaseContainers();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "abc123456789",
      name: "my-postgres",
      image: "postgres:15",
      port: 5433,
      status: "running",
    });
    expect(result[1]).toEqual({
      id: "def456789012",
      name: "my-redis",
      image: "redis:7",
      port: 6380,
      status: "running",
    });
  });

  it("returns empty on error", async () => {
    mockListContainers.mockRejectedValue(new Error("Docker not available"));

    const result = await listDatabaseContainers();
    expect(result).toEqual([]);
  });
});

describe("waitForHealthy", () => {
  it("returns true when container is running", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes",
      },
    ]);

    const result = await waitForHealthy("roubo-project-bench-1", "db", 5000);
    expect(result).toBe(true);
  });

  it("returns false early when container is stopped", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "exited",
        Status: "Exited (1) 2 seconds ago",
      },
    ]);

    const result = await waitForHealthy("roubo-project-bench-1", "db", 5000);
    expect(result).toBe(false);
  });

  it("returns false immediately when container is unhealthy", async () => {
    mockListContainers.mockResolvedValue([
      {
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
        State: "running",
        Status: "Up 5 minutes (unhealthy)",
      },
    ]);

    const result = await waitForHealthy("roubo-project-bench-1", "db", 5000);
    expect(result).toBe(false);
  });

  it("returns false immediately when container is not_found", async () => {
    mockListContainers.mockResolvedValue([]);

    const result = await waitForHealthy("roubo-project-bench-1", "db", 5000);
    expect(result).toBe(false);
  });
});

describe("getContainerStatusById", () => {
  beforeEach(() => {
    mockInspect.mockReset();
  });

  it("returns running when container is running with no health check", async () => {
    mockInspect.mockResolvedValue({ State: { Running: true } });
    expect(await getContainerStatusById("abc123")).toBe("running");
  });

  it("returns running when container is running and healthy", async () => {
    mockInspect.mockResolvedValue({ State: { Running: true, Health: { Status: "healthy" } } });
    expect(await getContainerStatusById("abc123")).toBe("running");
  });

  it("returns unhealthy when health status is unhealthy", async () => {
    mockInspect.mockResolvedValue({ State: { Running: true, Health: { Status: "unhealthy" } } });
    expect(await getContainerStatusById("abc123")).toBe("unhealthy");
  });

  it("returns starting when health check is pending", async () => {
    mockInspect.mockResolvedValue({ State: { Running: true, Health: { Status: "starting" } } });
    expect(await getContainerStatusById("abc123")).toBe("starting");
  });

  it("returns stopped when container is not running", async () => {
    mockInspect.mockResolvedValue({ State: { Running: false } });
    expect(await getContainerStatusById("abc123")).toBe("stopped");
  });

  it("returns not_found when inspect throws", async () => {
    mockInspect.mockRejectedValue(new Error("No such container"));
    expect(await getContainerStatusById("deadbeef")).toBe("not_found");
  });
});

describe("getContainerId", () => {
  it("returns the container Id for a matching compose service", async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: "abc123def456",
        Labels: {
          "com.docker.compose.project": "roubo-project-bench-1",
          "com.docker.compose.service": "db",
        },
      },
    ]);
    expect(await getContainerId("roubo-project-bench-1", "db")).toBe("abc123def456");
  });

  it("returns null when no container matches", async () => {
    mockListContainers.mockResolvedValue([
      {
        Id: "other",
        Labels: {
          "com.docker.compose.project": "other-project",
          "com.docker.compose.service": "web",
        },
      },
    ]);
    expect(await getContainerId("roubo-project-bench-1", "db")).toBeNull();
  });

  it("returns null when listContainers throws", async () => {
    mockListContainers.mockRejectedValue(new Error("docker down"));
    expect(await getContainerId("p", "db")).toBeNull();
  });
});
