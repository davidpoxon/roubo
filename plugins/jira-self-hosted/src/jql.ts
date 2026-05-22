/**
 * JQL builder for incremental polling.
 *
 * FR-026: every poll must include `updated >= <iso>` keyed off a stored
 * per-source watermark. We always end with `ORDER BY updated ASC` so the
 * highest-`updated` seen on a page is also the last item — that's what
 * `state-store.setLastPoll` writes back after a successful page.
 *
 * Boards are resolved to their backing filter id by the source picker
 * (boards are filters in Jira's data model), so the builder only needs
 * `filter` and `epic` source kinds at this layer.
 */

export type SourceKind = "filter" | "epic";

export interface SourceClause {
  kind: SourceKind;
  externalId: string;
}

export interface BuildJqlInput {
  sources: SourceClause[];
  lastPollIso: string | null;
}

export function buildIssueListJql({ sources, lastPollIso }: BuildJqlInput): string {
  const sourceClause = sources.length === 0 ? "" : `(${sources.map(toClause).join(" OR ")})`;
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
  }
}

function jqlNumericOrQuoted(value: string): string {
  if (/^[0-9]+$/.test(value)) return value;
  return jqlString(value);
}

function jqlString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
