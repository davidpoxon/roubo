import { describe, it, expect } from "vitest";
import { computeImpact } from "./computeImpact";
import type { RouboConfig, Bench } from "@roubo/shared";

const BASE_CONFIG: RouboConfig = {
  project: { name: "nova", type: "single", defaultBranch: "main", displayName: "Nova" },
  layout: { root: "." },
  components: {
    backend: { image: "node@20", port: 3000 },
    frontend: { image: "vite@5", port: 5173 },
  },
  ports: {
    backend: { base: 3000 },
    frontend: { base: 5173 },
  },
  benches: { max: 3 },
  tools: [],
} as unknown as RouboConfig;

function makeBench(
  id: number,
  status: Bench["status"],
  componentStatuses: Record<string, string> = {},
): Bench {
  const components: Bench["components"] = {};
  for (const [name, s] of Object.entries(componentStatuses)) {
    components[name] = {
      name,
      status: s as Bench["components"][string]["status"],
      setupComplete: true,
    };
  }
  return {
    id,
    projectId: "nova",
    branch: `feat-${id}`,
    workspacePath: `/ws/${id}`,
    status,
    ports: {},
    components,
    createdAt: new Date().toISOString(),
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
  };
}

describe("computeImpact", () => {
  it("returns changed=false and empty lists when no config diff", () => {
    const bench = makeBench(1, "active", { backend: "running" });
    const result = computeImpact(BASE_CONFIG, BASE_CONFIG, [bench]);
    expect(result.changed).toBe(false);
    expect(result.affected).toHaveLength(0);
    expect(result.unaffectedActive).toHaveLength(1);
  });

  it("returns idleCount for idle benches", () => {
    const benches = [makeBench(1, "idle"), makeBench(2, "idle")];
    const result = computeImpact(BASE_CONFIG, BASE_CONFIG, benches);
    expect(result.idleCount).toBe(2);
    expect(result.affected).toHaveLength(0);
  });

  it("marks active bench as affected when component image changes", () => {
    const pending = {
      ...BASE_CONFIG,
      components: { ...BASE_CONFIG.components, backend: { image: "node@22", port: 3000 } },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "active", { backend: "running" });
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.changed).toBe(true);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].reasons).toContain("components.backend changed");
  });

  it("marks active bench as affected when port base changes", () => {
    const pending = {
      ...BASE_CONFIG,
      ports: { ...BASE_CONFIG.ports, frontend: { base: 5200 } },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "active", { frontend: "running" });
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.changed).toBe(true);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].reasons.some((r) => r.includes("ports.frontend"))).toBe(true);
  });

  it("marks active bench as affected when benches.setup changes", () => {
    const pending = {
      ...BASE_CONFIG,
      benches: { ...BASE_CONFIG.benches, setup: "npm ci" },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "active", { backend: "running" });
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].reasons).toContain("benches.setup changed");
  });

  it("does not mark idle bench as affected even when config changes", () => {
    const pending = {
      ...BASE_CONFIG,
      components: { ...BASE_CONFIG.components, backend: { image: "node@22", port: 3000 } },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "idle");
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.affected).toHaveLength(0);
    expect(result.idleCount).toBe(1);
  });

  it("handles empty bench list", () => {
    const result = computeImpact(BASE_CONFIG, BASE_CONFIG, []);
    expect(result.affected).toHaveLength(0);
    expect(result.idleCount).toBe(0);
  });

  it("handles undefined savedConfig", () => {
    const bench = makeBench(1, "active", { backend: "running" });
    const result = computeImpact(BASE_CONFIG, undefined, [bench]);
    expect(result.changed).toBe(false);
  });

  it("marks bench with preparing status as running", () => {
    const pending = {
      ...BASE_CONFIG,
      benches: { ...BASE_CONFIG.benches, setup: "npm ci" },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "preparing");
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.affected).toHaveLength(1);
  });

  it("removed component generates only removed reason, not also changed", () => {
    const pending = {
      ...BASE_CONFIG,
      components: { frontend: { image: "vite@5", port: 5173 } },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "active", { backend: "running", frontend: "running" });
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.affected[0].reasons).toContain("components.backend removed");
    expect(result.affected[0].reasons).not.toContain("components.backend changed");
  });

  it("added component generates only added reason, not also changed", () => {
    const pending = {
      ...BASE_CONFIG,
      components: { ...BASE_CONFIG.components, worker: { image: "node@20", port: 4000 } },
    } as unknown as RouboConfig;
    const bench = makeBench(1, "active", { backend: "running", frontend: "running" });
    const result = computeImpact(pending, BASE_CONFIG, [bench]);
    expect(result.affected[0].reasons).toContain("components.worker added");
    expect(result.affected[0].reasons).not.toContain("components.worker changed");
  });
});
