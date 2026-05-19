function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

export async function checkForUpdate(currentVersion: string): Promise<void> {
  try {
    const res = await fetch("https://registry.npmjs.org/roubo/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (typeof latest !== "string") return;
    if (isNewer(currentVersion, latest)) {
      console.log(`Update available: ${currentVersion} → ${latest}. Run npm install -g roubo`);
    }
  } catch {
    // Fail silently — network unavailable, timeout, parse error, etc.
  }
}
