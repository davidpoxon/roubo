import type {
  BenchContext,
  ComponentHostClient,
  ComponentStatus,
  ImperativeComponentContract,
} from "@roubo/plugin-sdk";

// The imperative (escape-hatch) deploy lifecycle, factored out of the
// registration entrypoint so it can be unit-tested against a mocked host. The
// CP-TC-028 journey: the start hook gates on the broker capability, runs a
// single command to completion through the host, and reports `completed`.

export function buildContract(host: ComponentHostClient): ImperativeComponentContract {
  // Terminal status of the most recent deploy, returned from `health` so the
  // host can poll it independently of the pushed `reportStatus` notification.
  let lastStatus: ComponentStatus["status"] = "stopped";

  return {
    async start(context: BenchContext): Promise<void> {
      lastStatus = "starting";
      host.component.reportStatus({ status: "starting" });

      // CP-FR-017 graceful version gate: ask the host whether the broker method
      // this plugin depends on is available before driving it. On a host too
      // old to expose `host.process.run`, `available` is false and the plugin
      // degrades rather than crashes; on a compatible host it is true.
      const capability = await host.capability.query({ method: "host.process.run" });
      if (!capability.available) {
        lastStatus = "error";
        host.component.reportStatus({
          status: "error",
          error: "host.process.run is unavailable on this host",
        });
        return;
      }

      // Run the deploy command to completion through the host broker. The host
      // owns the spawned process; `run` blocks until it exits and returns the
      // exit code.
      const result = await host.process.run({
        id: "deploy-1",
        command: "echo",
        args: ["deployed"],
        env: context.env,
        cwd: context.workspacePath,
        timeoutMs: 10_000,
      });

      if (result.exitCode !== 0) {
        lastStatus = "error";
        host.component.reportStatus({
          status: "error",
          error: `deploy command exited ${result.exitCode}`,
        });
        return;
      }

      lastStatus = "completed";
      host.component.reportStatus({ status: "completed" });
    },

    stop(_context: BenchContext): void {
      lastStatus = "stopped";
      host.component.reportStatus({ status: "stopped" });
    },

    health(_context: BenchContext): ComponentStatus {
      return { status: lastStatus };
    },

    cleanup(_context: BenchContext): void {
      // One-shot lifecycle: the deploy command already ran to completion, so
      // there is no long-lived process to reap here. The host clears the
      // resource ledger for (pluginId, benchId) after cleanup returns.
      lastStatus = "stopped";
    },
  };
}
