import type { RouboConfig, RegisteredProject } from "@roubo/shared";

export function allocatePorts(config: RouboConfig, benchNumber: number): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const [name, portConfig] of Object.entries(config.ports)) {
    ports[name] = portConfig.base + (benchNumber - 1);
  }
  return ports;
}

export interface PortRange {
  name: string;
  projectId: string;
  low: number;
  high: number;
}

export interface PortConflict {
  newRange: PortRange;
  existingRange: PortRange;
}

export function getPortConflicts(
  newProject: { id: string; config: RouboConfig },
  existingProjects: RegisteredProject[],
): PortConflict[] {
  const conflicts: PortConflict[] = [];
  const newRanges = getPortRanges(newProject.id, newProject.config);

  for (const existing of existingProjects) {
    if (existing.id === newProject.id || !existing.config) continue;
    const existingRanges = getPortRanges(existing.id, existing.config);

    for (const nr of newRanges) {
      for (const er of existingRanges) {
        if (nr.low <= er.high && er.low <= nr.high) {
          conflicts.push({ newRange: nr, existingRange: er });
        }
      }
    }
  }

  return conflicts;
}

export function checkPortConflicts(
  newProject: { id: string; config: RouboConfig },
  existingProjects: RegisteredProject[],
): string[] {
  return getPortConflicts(newProject, existingProjects).map(
    ({ newRange, existingRange }) =>
      `Port conflict: ${newRange.projectId}.${newRange.name} (${newRange.low}-${newRange.high}) ` +
      `overlaps with ${existingRange.projectId}.${existingRange.name} (${existingRange.low}-${existingRange.high})`,
  );
}

function getPortRanges(projectId: string, config: RouboConfig): PortRange[] {
  return Object.entries(config.ports).map(([name, portConfig]) => ({
    name,
    projectId,
    low: portConfig.base,
    high: portConfig.base + config.benches.max - 1,
  }));
}
