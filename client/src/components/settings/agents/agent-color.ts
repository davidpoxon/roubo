// Deterministic colour per agent plugin (AP-TC-044, #1057).
//
// `AgentPluginState` carries no colour of its own, and widening the wire type
// so a plugin could pick one would let two plugins claim the same swatch. A
// pure function of the plugin id is smaller and stable: the same agent always
// reads the same colour in the preset list, in every bench, across restarts.
//
// The two agents the design mocks name are seeded explicitly so the shipped
// palette matches the prototype; everything else hashes into the remaining
// swatches.
//
// Each swatch is a background/foreground PAIR of literal Tailwind class names.
// Both are written out in full because Tailwind scans source text for whole
// class names, so a `bg-` string rewritten into a `text-` one at runtime would
// never be generated (#1063, where the Terminal tab needs the foreground
// form for a session's agent glyph).

interface Swatch {
  bg: string;
  text: string;
}

// DESIGN.md agent swatches 1-6: violet, cyan, emerald, lime, rose, sky. Each is
// tuned per theme (the 600 step on light, the 400 step on dark) by
// semantic-dark.css, so a dot holds 3:1 against its surface in both. Amber is
// reserved for the accent and for work in progress, so no swatch uses it.
const VIOLET: Swatch = { bg: "bg-agent-swatch-1", text: "text-agent-swatch-1" };
const CYAN: Swatch = { bg: "bg-agent-swatch-2", text: "text-agent-swatch-2" };

const SEEDED: Record<string, Swatch> = {
  "claude-code": VIOLET,
  "codex-cli": CYAN,
};

const PALETTE: Swatch[] = [
  VIOLET,
  CYAN,
  { bg: "bg-agent-swatch-3", text: "text-agent-swatch-3" },
  { bg: "bg-agent-swatch-4", text: "text-agent-swatch-4" },
  { bg: "bg-agent-swatch-5", text: "text-agent-swatch-5" },
  { bg: "bg-agent-swatch-6", text: "text-agent-swatch-6" },
];

const UNKNOWN: Swatch = { bg: "bg-status-idle", text: "text-text-secondary" };

function swatch(pluginId: string | undefined): Swatch {
  if (!pluginId) return UNKNOWN;
  const seeded = SEEDED[pluginId];
  if (seeded) return seeded;
  let hash = 0;
  for (let i = 0; i < pluginId.length; i++) {
    hash = (hash * 31 + pluginId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/** The Tailwind background class for an agent's colour dot. */
export function agentDotClass(pluginId: string | undefined): string {
  return swatch(pluginId).bg;
}

/** The same swatch as a foreground class, for an agent glyph rather than a dot. */
export function agentTextClass(pluginId: string | undefined): string {
  return swatch(pluginId).text;
}
