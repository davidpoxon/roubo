import type { Response } from "express";
import type { Bench, BenchNotification, BenchStatus } from "@roubo/shared";

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

export type SseEvent = NotificationEvent | BenchStatusEvent;

const clients = new Set<Response>();

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

export function getClientCount(): number {
  return clients.size;
}

export function _resetClientsForTest(): void {
  clients.clear();
}
