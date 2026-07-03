import type { Response } from "express";
import type { Bench, BenchNotification, BenchStatus, ComponentStatusValue } from "@roubo/shared";

export interface NotificationEvent {
  type: "notifications";
  projectId: string;
  benchId: number;
  notifications: BenchNotification[];
}

export interface BenchStatusEvent {
  type: "bench-status";
  projectId: string;
  benchId: number;
  status: BenchStatus;
}

/**
 * A single component's observable status transition (CP-FR-014 / CP-NFR-004,
 * #397). Distinct from the bench-scoped `bench-status` event: it names the
 * component and carries a per-component monotonic `ts`, so a client can render
 * an ordered, deduplicated per-component timeline across a crash-and-recovery
 * cycle (CP-TC-074). Emitted by broadcastComponentStatusChange, which suppresses
 * consecutive duplicates and clamps `ts` forward per component.
 */
export interface ComponentStatusChangeEvent {
  type: "component-status-change";
  projectId: string;
  benchId: number;
  component: string;
  status: ComponentStatusValue;
  ts: number;
}

export type SseEvent = NotificationEvent | BenchStatusEvent | ComponentStatusChangeEvent;

const clients = new Set<Response>();

// Per-(projectId, benchId, component) record of the last broadcast component
// status and its clamped timestamp, backing broadcastComponentStatusChange's
// consecutive-duplicate suppression and monotonic-ts guarantee (CP-TC-074).
const lastComponentStatus = new Map<string, { status: ComponentStatusValue; ts: number }>();

function componentStatusKey(projectId: string, benchId: number, component: string): string {
  return `${projectId}:${benchId}:${component}`;
}

export function addClient(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(":ok\n\n");

  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

export function broadcast(event: SseEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

export function broadcastBenchStatus(bench: Bench): void {
  broadcast({
    type: "bench-status",
    projectId: bench.projectId,
    benchId: bench.id,
    status: bench.status,
  });
}

/**
 * Broadcast a component's status transition (CP-FR-014 / CP-NFR-004, #397).
 *
 * Two invariants CP-TC-074 asserts across a crash-and-recovery cycle:
 *   - Consecutive duplicates are suppressed: a repeated (component, status) pair
 *     (e.g. the 5s status poll re-observing `running`) emits no event. Only a
 *     genuine change from the component's last broadcast status is sent.
 *   - `ts` is monotonically increasing per component: it is clamped to at least
 *     one millisecond past the component's previous event, so a client never
 *     sees an out-of-order timestamp even when two transitions land in the same
 *     wall-clock millisecond. Different components keep independent sequences.
 */
export function broadcastComponentStatusChange(
  projectId: string,
  benchId: number,
  component: string,
  status: ComponentStatusValue,
): void {
  const key = componentStatusKey(projectId, benchId, component);
  const prev = lastComponentStatus.get(key);
  if (prev && prev.status === status) return;

  const ts = Math.max(Date.now(), (prev?.ts ?? 0) + 1);
  lastComponentStatus.set(key, { status, ts });
  broadcast({ type: "component-status-change", projectId, benchId, component, status, ts });
}

/**
 * Drop every per-component status record for a bench (#397). Called on bench
 * teardown alongside the other per-bench in-memory clears (clearAuditLog /
 * unregisterBrokerContextsForBench), so a bench id that is later reused does not
 * inherit the prior generation's last component status and wrongly suppress the
 * new bench's first component-status-change as a consecutive duplicate.
 */
export function clearComponentStatusForBench(projectId: string, benchId: number): void {
  const prefix = `${projectId}:${benchId}:`;
  for (const key of lastComponentStatus.keys()) {
    if (key.startsWith(prefix)) lastComponentStatus.delete(key);
  }
}

export function getClientCount(): number {
  return clients.size;
}

export function _resetClientsForTest(): void {
  clients.clear();
  lastComponentStatus.clear();
}
