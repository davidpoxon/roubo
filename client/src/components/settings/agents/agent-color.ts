// Deterministic colour per agent plugin (AP-TC-044, issue #516).
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
// never be generated (issue #517, where the Terminal tab needs the foreground
// form for a session's agent glyph).

interface Swatch {
  bg: string;
  text: string;
}

const VIOLET: Swatch = { bg: "bg-violet-400", text: "text-violet-400" };
const CYAN: Swatch = { bg: "bg-cyan-400", text: "text-cyan-400" };

const SEEDED: Record<string, Swatch> = {
  "claude-code": VIOLET,
  "codex-cli": CYAN,
};

const PALETTE: Swatch[] = [
  VIOLET,
  CYAN,
  { bg: "bg-emerald-400", text: "text-emerald-400" },
  { bg: "bg-amber-400", text: "text-amber-400" },
  { bg: "bg-rose-400", text: "text-rose-400" },
  { bg: "bg-sky-400", text: "text-sky-400" },
];

const UNKNOWN: Swatch = { bg: "bg-stone-500", text: "text-stone-500" };

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
