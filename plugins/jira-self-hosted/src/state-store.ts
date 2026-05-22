import { host } from "@roubo/plugin-sdk";

/**
 * Per-source last-poll watermark store. FR-026 requires the plugin to
 * persist its own watermark in plugin-scoped state; the host exposes no
 * generic state API, so we serialize a JSON map to the `state`
 * credential slot. The slot is opaque to the host and survives plugin
 * restarts.
 *
 * Keys are source identifiers (board id, filter id, epic key); values
 * are ISO timestamps the next poll passes to `updated >=`.
 */

const SLOT = "state";

type StateMap = Record<string, string>;

let cache: StateMap | null = null;

async function loadCache(): Promise<StateMap> {
  if (cache !== null) return cache;
  const raw = await host.credentials.get(SLOT);
  if (raw === null || raw === "") {
    cache = {};
    return cache;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sanitized: StateMap = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") sanitized[key] = value;
      }
      cache = sanitized;
      return cache;
    }
  } catch {
    // Corrupt slot: start fresh rather than crash the plugin. The next
    // successful set() overwrites with a clean map.
  }
  cache = {};
  return cache;
}

export async function getLastPoll(sourceKey: string): Promise<string | null> {
  const map = await loadCache();
  return map[sourceKey] ?? null;
}

export async function setLastPoll(sourceKey: string, iso: string): Promise<void> {
  const map = await loadCache();
  map[sourceKey] = iso;
  await host.credentials.set(SLOT, JSON.stringify(map));
}

/** Test seam: drop the in-process cache so the next get() re-reads the slot. */
export function _resetCacheForTests(): void {
  cache = null;
}
