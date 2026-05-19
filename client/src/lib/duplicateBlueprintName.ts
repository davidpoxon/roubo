const COPY_SUFFIX_RE = /^(.*?)\s*\(copy(?:\s+(\d+))?\)\s*$/;

const MAX_NAME_LENGTH = 100;

function buildCandidate(base: string, n: number | null): string {
  const suffix = n === null ? " (copy)" : ` (copy ${n})`;
  if (base.length + suffix.length <= MAX_NAME_LENGTH) return base + suffix;
  const maxBase = Math.max(1, MAX_NAME_LENGTH - suffix.length);
  return base.slice(0, maxBase).trimEnd() + suffix;
}

export function deriveDuplicateName(originalName: string, existingNames: string[]): string {
  const trimmed = originalName.trim();
  const match = COPY_SUFFIX_RE.exec(trimmed);
  const base = match ? match[1] : trimmed;

  const taken = new Set(existingNames.map((n) => n.toLowerCase()));

  const first = buildCandidate(base, null);
  if (!taken.has(first.toLowerCase())) return first;

  for (let i = 2; i < 1000; i++) {
    const candidate = buildCandidate(base, i);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }

  throw new Error("Unable to derive a unique duplicate name");
}
