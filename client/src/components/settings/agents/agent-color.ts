// Deterministic dot colour per agent plugin (AP-TC-044, issue #516).
//
// `AgentPluginState` carries no colour of its own, and widening the wire type
// so a plugin could pick one would let two plugins claim the same swatch. A
// pure function of the plugin id is smaller and stable: the same agent always
// reads the same colour in the preset list, in every bench, across restarts.
//
// The two agents the design mocks name are seeded explicitly so the shipped
// palette matches the prototype; everything else hashes into the remaining
// swatches.

const SEEDED: Record<string, string> = {
  "claude-code": "bg-violet-400",
  "codex-cli": "bg-cyan-400",
};

const PALETTE = [
  "bg-violet-400",
  "bg-cyan-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-rose-400",
  "bg-sky-400",
];

/** The Tailwind background class for an agent's colour dot. */
export function agentDotClass(pluginId: string | undefined): string {
  if (!pluginId) return "bg-stone-500";
  const seeded = SEEDED[pluginId];
  if (seeded) return seeded;
  let hash = 0;
  for (let i = 0; i < pluginId.length; i++) {
    hash = (hash * 31 + pluginId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
