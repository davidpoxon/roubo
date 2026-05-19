import type { RouboConfig, Bench } from "@roubo/shared";

export interface AffectedBench {
  id: number;
  displayName: string;
  reasons: string[];
}

export interface ImpactResult {
  changed: boolean;
  affected: AffectedBench[];
  unaffectedActive: { id: number; displayName: string }[];
  idleCount: number;
}

export function isRunning(bench: Bench): boolean {
  if (bench.status === "active" || bench.status === "preparing") return true;
  return Object.values(bench.components).some(
    (c) => c.status === "running" || c.status === "starting",
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[];
    const ab = b as unknown[];
    if (aa.length !== ab.length) return false;
    return aa.every((v, i) => deepEqual(v, ab[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && deepEqual(ao[k], bo[k]));
}

export function computeImpact(
  pendingConfig: RouboConfig,
  savedConfig: RouboConfig | undefined,
  benches: Bench[],
): ImpactResult {
  if (!savedConfig) {
    return {
      changed: false,
      affected: [],
      unaffectedActive: [],
      idleCount: benches.length,
    };
  }

  const changedSections: string[] = [];

  if (!deepEqual(pendingConfig.components, savedConfig.components)) {
    changedSections.push("components");
  }
  if (!deepEqual(pendingConfig.ports, savedConfig.ports)) {
    changedSections.push("ports");
  }
  if (!deepEqual(pendingConfig.benches?.setup, savedConfig.benches?.setup)) {
    changedSections.push("benches.setup");
  }
  if (!deepEqual(pendingConfig.tools, savedConfig.tools)) {
    changedSections.push("tools");
  }
  if (!deepEqual(pendingConfig.inspection, savedConfig.inspection)) {
    changedSections.push("inspection");
  }

  const changed = changedSections.length > 0;

  const affected: AffectedBench[] = [];
  const unaffectedActive: { id: number; displayName: string }[] = [];
  let idleCount = 0;

  for (const bench of benches) {
    const displayName = bench.branch || `bench-${bench.id}`;

    if (!isRunning(bench)) {
      idleCount++;
      continue;
    }

    if (!changed) {
      unaffectedActive.push({ id: bench.id, displayName });
      continue;
    }

    const reasons: string[] = [];

    const benchComponentNames = new Set(Object.keys(bench.components));

    if (changedSections.includes("components")) {
      const pendingComponentNames = Object.keys(pendingConfig.components ?? {});
      const savedComponentNames = Object.keys(savedConfig.components ?? {});
      const added = pendingComponentNames.filter((n) => !savedComponentNames.includes(n));
      const removed = savedComponentNames.filter((n) => !pendingComponentNames.includes(n));
      for (const name of benchComponentNames) {
        // Skip added/removed — those get dedicated reason strings below
        if (added.includes(name) || removed.includes(name)) continue;
        const pendingDef = (pendingConfig.components as Record<string, unknown>)?.[name];
        const savedDef = (savedConfig.components as Record<string, unknown>)?.[name];
        if (!deepEqual(pendingDef, savedDef)) {
          reasons.push(`components.${name} changed`);
        }
      }
      for (const n of added) reasons.push(`components.${n} added`);
      for (const n of removed) reasons.push(`components.${n} removed`);
    }

    if (changedSections.includes("ports")) {
      const pendingPorts = pendingConfig.ports as Record<string, unknown> | undefined;
      const savedPorts = savedConfig.ports as Record<string, unknown> | undefined;
      const portNames = new Set([
        ...Object.keys(pendingPorts ?? {}),
        ...Object.keys(savedPorts ?? {}),
      ]);
      for (const portName of portNames) {
        if (!deepEqual(pendingPorts?.[portName], savedPorts?.[portName])) {
          reasons.push(`ports.${portName} changed`);
        }
      }
    }

    if (changedSections.includes("benches.setup")) {
      reasons.push("benches.setup changed");
    }

    if (changedSections.includes("tools")) {
      reasons.push("tools changed");
    }

    if (changedSections.includes("inspection")) {
      reasons.push("inspection changed");
    }

    if (reasons.length > 0) {
      affected.push({ id: bench.id, displayName, reasons });
    } else {
      unaffectedActive.push({ id: bench.id, displayName });
    }
  }

  return { changed, affected, unaffectedActive, idleCount };
}
