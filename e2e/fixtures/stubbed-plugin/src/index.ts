import { definePlugin } from "@roubo/plugin-sdk";
import { parseArgs } from "./args.js";
import { createClock } from "./clock.js";
import { buildContract } from "./contract.js";
import { createJournal } from "./journal.js";
import { loadScenario } from "./scenario.js";

const { scenario: scenarioName, now } = parseArgs(process.argv.slice(2));
const scenario = loadScenario(scenarioName);

// WU-066 (TC-172): scenarios may script the stub to refuse start so the host
// surfaces an `rpc-init-failed` entry to the Enable-plugin prompt modal.
// Exit non-zero BEFORE definePlugin opens the RPC channel so plugin-manager
// observes a spawn whose child died during init.
if (scenario.failOnStart) {
  process.stderr.write(`stubbed-plugin: refusing to start (scenario=${scenarioName})\n`);
  process.exit(1);
}

const clock = createClock(now);
const journal = createJournal();

definePlugin(buildContract({ scenario, clock, journal }));
