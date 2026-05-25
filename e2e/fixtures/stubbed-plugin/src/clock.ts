export interface Clock {
  nowIso(): string;
}

export function createClock(pinned: Date): Clock {
  const frozenIso = pinned.toISOString();
  return Object.freeze({
    nowIso(): string {
      return frozenIso;
    },
  });
}
