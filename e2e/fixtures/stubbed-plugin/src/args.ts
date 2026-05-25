export interface ParsedArgs {
  scenario: string;
  now: Date;
}

const DEFAULT_SCENARIO = "default";
const DEFAULT_NOW_ISO = "2026-01-01T00:00:00.000Z";

function readFlag(argv: readonly string[], flag: string): string | undefined {
  const prefix = `--${flag}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const scenario = readFlag(argv, "scenario") ?? DEFAULT_SCENARIO;
  if (!/^[a-z][a-z0-9-]*$/.test(scenario)) {
    throw new Error(
      `Invalid --scenario value "${scenario}": must be kebab-case (lowercase letters, digits, hyphens).`,
    );
  }

  const nowRaw = readFlag(argv, "now") ?? DEFAULT_NOW_ISO;
  const now = new Date(nowRaw);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid --now value "${nowRaw}": must be an ISO-8601 timestamp.`);
  }

  return { scenario, now };
}
