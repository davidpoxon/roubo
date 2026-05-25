import { definePlugin } from "@roubo/plugin-sdk";
import { parseArgs } from "./args.js";
import { createClock } from "./clock.js";
import { buildContract } from "./contract.js";
import { createJournal } from "./journal.js";
import { loadScenario } from "./scenario.js";

const { scenario: scenarioName, now } = parseArgs(process.argv.slice(2));
const scenario = loadScenario(scenarioName);
const clock = createClock(now);
const journal = createJournal();

definePlugin(buildContract({ scenario, clock, journal }));
