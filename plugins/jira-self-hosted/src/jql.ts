/**
 * JQL builder for incremental polling.
 *
 * FR-026: every poll must include `updated >= <iso>` keyed off a stored
 * per-source watermark. We always end with `ORDER BY updated ASC` so the
 * highest-`updated` seen on a page is also the last item. That's what
 * `state-store.setLastPoll` writes back after a successful page.
 *
 * Source kinds (FR-004/FR-007/FR-008): `filter` and `epic` map straight to a
 * JQL clause; `project` scopes to a single project key; `board` is resolved to
 * its active-sprint / whole-board clause at list time (`board-resolve.ts`) and
 * arrives here pre-resolved on `SourceClause.resolvedClause`; `mine` ("assigned
 * to me") uses the native `currentUser()` function, optionally narrowed to the
 * in-scope project keys.
 */

export type SourceKind = "filter" | "epic" | "project" | "board" | "mine";

export interface SourceClause {
  kind: SourceKind;
  externalId: string;
  /**
   * `board` only: the JQL clause produced by `board-resolve.ts` at list time
   * (active sprint or whole-board backing filter). An empty/absent value means
   * the board could not be resolved and the clause is dropped from the union.
   */
  resolvedClause?: string;
  /** `board` only: which mode produced `resolvedClause` (for the watermark key). */
  boardMode?: "active-sprint" | "whole-board";
  /** `mine` only: in-scoped-projects vs anywhere. */
  mineScope?: "in-project" | "anywhere";
  /** `mine` only: the in-scope project keys to narrow `in-project` mode by. */
  scopeProjectKeys?: string[];
}

export interface BuildJqlInput {
  sources: SourceClause[];
  lastPollIso: string | null;
}

export function buildIssueListJql({ sources, lastPollIso }: BuildJqlInput): string {
  // Drop empty clauses (e.g. an unresolvable board) before the OR join so the
  // union never degenerates into `( OR ...)`.
  const parts = sources.map(toClause).filter((part) => part.length > 0);
  const sourceClause = parts.length === 0 ? "" : `(${parts.join(" OR ")})`;
  const updatedClause = lastPollIso === null ? "" : `updated >= "${lastPollIso}"`;

  const where = [sourceClause, updatedClause].filter((part) => part.length > 0).join(" AND ");
  const tail = "ORDER BY updated ASC";
  return where.length > 0 ? `${where} ${tail}` : tail;
}

function toClause(source: SourceClause): string {
  switch (source.kind) {
    case "filter":
      return `filter = ${jqlNumericOrQuoted(source.externalId)}`;
    case "epic":
      return `"Epic Link" = ${jqlString(source.externalId)}`;
    case "project":
      return `project = ${jqlString(source.externalId)}`;
    case "board":
      // Resolved upstream at list time; an unresolved board contributes nothing.
      return source.resolvedClause ?? "";
    case "mine": {
      const keys = source.scopeProjectKeys ?? [];
      if (source.mineScope === "in-project" && keys.length > 0) {
        const list = keys.map(jqlString).join(", ");
        return `(assignee = currentUser() AND project in (${list}))`;
      }
      return "assignee = currentUser()";
    }
  }
}

export function jqlNumericOrQuoted(value: string): string {
  if (/^[0-9]+$/.test(value)) return value;
  return jqlString(value);
}

function jqlString(value: string): string {
  // Escape backslashes first, then double quotes, so an input like `\"` can't
  // smuggle in an unescaped quote. JQL string literals use C-style escapes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Upper bound on a user-typed search term before it is interpolated into JQL. */
const SEARCH_TERM_MAX_LENGTH = 100;

// JQL text-operator / wildcard hazards. The `~` (contains) operator gives these
// boolean/wildcard meaning, so they are neutralized before interpolation.
const JQL_TEXT_HAZARDS = /[+\-&|!(){}[\]^~*?:]/g;

/**
 * Drop ASCII control characters (code points below 0x20 and DEL) so they can
 * never affect the quoted literal. Done by code point rather than a regex to
 * keep the source free of literal control bytes.
 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Escape a user-typed search term for safe interpolation into a JQL text match
 * (e.g. `summary ~ <jqlSearchTerm(term)>`). Beyond the backslash/quote escaping
 * `jqlString` does, the `~` (contains) operator gives meaning to wildcard and
 * boolean characters (`* ? + - & | ! ( ) { } [ ] ^ ~ :`), so they are
 * neutralized to spaces; the term is also length-bounded. Returns a fully
 * quoted JQL string literal (NFR-003: a crafted term cannot break out of the
 * quoted literal or inject a clause). WU-005 may harden this further.
 */
export function jqlSearchTerm(raw: string): string {
  const bounded = String(raw ?? "").slice(0, SEARCH_TERM_MAX_LENGTH);
  const cleaned = stripControlChars(bounded)
    .replace(JQL_TEXT_HAZARDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return jqlString(cleaned);
}

/**
 * Validate a Jira project key for safe interpolation. A project key is never
 * free text, so an invalid one is rejected (not escaped): the source-options
 * search scopes `project in (...)` / `projectKeyOrId=` on these keys, and a
 * strict regex guarantees no injection surface. Returns the key on success.
 */
export function assertProjectKey(raw: string): string {
  if (typeof raw !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(raw)) {
    throw new Error(`Invalid Jira project key: ${JSON.stringify(raw)}`);
  }
  return raw;
}
