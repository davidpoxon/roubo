import type { AuditEntry } from "@roubo/shared";

/**
 * In-memory record of every privileged HostComponentBroker call (FR-019, v2
 * audit). Entries are appended in call order and queried, optionally filtered by
 * plugin and/or bench, in that same chronological order. This is an in-process
 * store only: nothing is persisted to state.json, so the log is empty after a
 * server restart.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  /**
   * Append one entry, preserving insertion (chronological) order. The broker
   * records one entry per gated method invocation, allowed or denied.
   */
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  /**
   * Return a copy of the recorded entries in chronological order, optionally
   * filtered by `pluginId` and/or `benchId`. A copy is returned so callers
   * cannot mutate the internal store.
   */
  query(filter: { pluginId?: string; benchId?: number } = {}): AuditEntry[] {
    return this.entries.filter((entry) => {
      if (filter.pluginId !== undefined && entry.pluginId !== filter.pluginId) {
        return false;
      }
      if (filter.benchId !== undefined && entry.benchId !== filter.benchId) {
        return false;
      }
      return true;
    });
  }
}
