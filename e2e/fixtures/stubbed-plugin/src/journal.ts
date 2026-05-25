/**
 * In-process journal that records mutating RPC effects so reads issued later
 * in the same process see the updated state. Reset on process restart; the
 * E2E harness restarts the stub between specs via WU-061's /test/__reset.
 */
export interface Journal {
  recordAssign(externalId: string, assigneeExternalId: string): void;
  recordUnassign(externalId: string, assigneeExternalId: string): void;
  recordTransition(externalId: string, transition: string): void;
  assigneesFor(externalId: string): { added: string[]; removed: string[] };
  transitionFor(externalId: string): string | undefined;
}

interface IssueState {
  added: Set<string>;
  removed: Set<string>;
  transition?: string;
}

export function createJournal(): Journal {
  const state = new Map<string, IssueState>();

  function get(externalId: string): IssueState {
    let entry = state.get(externalId);
    if (!entry) {
      entry = { added: new Set(), removed: new Set() };
      state.set(externalId, entry);
    }
    return entry;
  }

  function sortedArray(set: Set<string>): string[] {
    return [...set].sort();
  }

  return {
    recordAssign(externalId, assigneeExternalId) {
      const entry = get(externalId);
      entry.added.add(assigneeExternalId);
      entry.removed.delete(assigneeExternalId);
    },
    recordUnassign(externalId, assigneeExternalId) {
      const entry = get(externalId);
      entry.removed.add(assigneeExternalId);
      entry.added.delete(assigneeExternalId);
    },
    recordTransition(externalId, transition) {
      get(externalId).transition = transition;
    },
    assigneesFor(externalId) {
      const entry = state.get(externalId);
      if (!entry) return { added: [], removed: [] };
      return { added: sortedArray(entry.added), removed: sortedArray(entry.removed) };
    },
    transitionFor(externalId) {
      return state.get(externalId)?.transition;
    },
  };
}
