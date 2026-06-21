import { describe, expect, it, vi } from "vitest";
import type {
  BenchContext,
  CapabilityQueryResult,
  ComponentHostClient,
  ComponentStatus,
  ProcessRunResult,
} from "@roubo/plugin-sdk";
import { buildContract } from "./contract.js";

const CONTEXT: BenchContext = {
  projectId: "cp-tc-028",
  benchId: 1,
  componentName: "deploy",
  workspacePath: "/tmp/cp-tc-028/bench-1",
  ports: {},
  env: { DEPLOY_ENV: "stub" },
};

function makeHost(opts: { capability?: CapabilityQueryResult; run?: ProcessRunResult }): {
  host: ComponentHostClient;
  reportStatus: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const reportStatus = vi.fn<(status: ComponentStatus) => void>();
  const run = vi.fn(async () => opts.run ?? { exitCode: 0 });
  const query = vi.fn(async () => opts.capability ?? { available: true });
  const host = {
    process: {
      start: vi.fn(),
      run,
      stop: vi.fn(),
      status: vi.fn(),
      logs: vi.fn(),
    },
    docker: {} as ComponentHostClient["docker"],
    ports: {} as ComponentHostClient["ports"],
    component: { reportStatus, reportLog: vi.fn() },
    capability: { query },
  } as unknown as ComponentHostClient;
  return { host, reportStatus, run, query };
}

describe("clasp-deploy-stub contract", () => {
  it("implements all four imperative hooks", () => {
    const { host } = makeHost({});
    const contract = buildContract(host);
    expect(typeof contract.start).toBe("function");
    expect(typeof contract.stop).toBe("function");
    expect(typeof contract.health).toBe("function");
    expect(typeof contract.cleanup).toBe("function");
  });

  it("start queries capability, runs the deploy command, and reports completed", async () => {
    const { host, reportStatus, run, query } = makeHost({});
    const contract = buildContract(host);

    await contract.start(CONTEXT);

    expect(query).toHaveBeenCalledWith({ method: "host.process.run" });
    expect(run).toHaveBeenCalledWith({
      id: "deploy-1",
      command: "echo",
      args: ["deployed"],
      env: CONTEXT.env,
      cwd: CONTEXT.workspacePath,
      timeoutMs: 10_000,
    });
    expect(reportStatus).toHaveBeenLastCalledWith({ status: "completed" });
    expect(contract.health(CONTEXT)).toEqual({ status: "completed" });
  });

  it("start degrades gracefully when the host lacks host.process.run", async () => {
    const { host, reportStatus, run } = makeHost({ capability: { available: false } });
    const contract = buildContract(host);

    await contract.start(CONTEXT);

    expect(run).not.toHaveBeenCalled();
    expect(reportStatus).toHaveBeenLastCalledWith({
      status: "error",
      error: "host.process.run is unavailable on this host",
    });
    expect(contract.health(CONTEXT)).toEqual({ status: "error" });
  });

  it("start reports error when the deploy command exits non-zero", async () => {
    const { host, reportStatus } = makeHost({ run: { exitCode: 3 } });
    const contract = buildContract(host);

    await contract.start(CONTEXT);

    expect(reportStatus).toHaveBeenLastCalledWith({
      status: "error",
      error: "deploy command exited 3",
    });
    expect(contract.health(CONTEXT)).toEqual({ status: "error" });
  });

  it("stop reports stopped and health reflects it", () => {
    const { host, reportStatus } = makeHost({});
    const contract = buildContract(host);

    contract.stop(CONTEXT);

    expect(reportStatus).toHaveBeenLastCalledWith({ status: "stopped" });
    expect(contract.health(CONTEXT)).toEqual({ status: "stopped" });
  });

  it("cleanup resets terminal status to stopped", async () => {
    const { host } = makeHost({});
    const contract = buildContract(host);

    await contract.start(CONTEXT);
    expect(contract.health(CONTEXT)).toEqual({ status: "completed" });

    contract.cleanup(CONTEXT);
    expect(contract.health(CONTEXT)).toEqual({ status: "stopped" });
  });
});
