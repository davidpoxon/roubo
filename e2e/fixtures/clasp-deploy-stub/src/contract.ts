import type {
  BenchContext,
  ComponentHostClient,
  ComponentStatus,
  ImperativeComponentContract,
  ProcessRunResult,
} from "@roubo/plugin-sdk";

// The imperative (escape-hatch) deploy lifecycle, factored out of the
// registration entrypoint so it can be unit-tested against a mocked host. The
// CP-TC-028 journey: the start hook gates on the broker capability, runs a
// single command to completion through the host, and reports `completed`.

// The deploy command's timeout budget. The host force-kills a run that exceeds
// it and rejects `host.process.run` with a typed `process-timeout` error; the
// same constant names the timeout in the reported statusDetail so the run's
// bound and its error message never drift. Matches CP-TC-068's timeoutMs.
const DEPLOY_TIMEOUT_MS = 5000;

// The host rejects a timed-out `host.process.run` with a typed error whose
// structured `data.code` is "process-timeout" (server component-broker, #411).
// Match on that code rather than the message so the timeout branch stays robust.
function isProcessTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("data" in err)) return false;
  const data = (err as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    (data as { code?: unknown }).code === "process-timeout"
  );
}

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
      // exit code. A timeoutMs-enforced kill does not resolve: the host rejects
      // with a typed `process-timeout` error (#411), which we catch below.
      let result: ProcessRunResult;
      try {
        result = await host.process.run({
          id: "deploy-1",
          command: "echo",
          args: ["deployed"],
          env: context.env,
          cwd: context.workspacePath,
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
      } catch (err) {
        // Name the timeout in statusDetail so the component surface says the
        // deploy timed out (CP-TC-068 S004-O01), not just that a command failed.
        if (isProcessTimeout(err)) {
          lastStatus = "error";
          host.component.reportStatus({
            status: "error",
            error: `deploy command timed out after ${DEPLOY_TIMEOUT_MS}ms`,
            statusDetail: `Timed out after ${DEPLOY_TIMEOUT_MS}ms`,
          });
          return;
        }
        // Any other host.process.run failure propagates unchanged; the host's
        // provisionImperativeComponent catch drives the component to error.
        throw err;
      }

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
