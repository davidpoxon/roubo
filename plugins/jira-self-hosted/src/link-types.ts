/**
 * Map Jira issue-links to NormalizedIssue.blocks / blockedBy per FR-025.
 *
 * Defaults: the link type named "blocks" with an outwardIssue produces a
 * `blocks` entry; "is blocked by" with an inwardIssue produces a
 * `blockedBy` entry. Both names are configurable per project to
 * accommodate Jira instances that have renamed the default link types
 * (TC-072). Every other link type is intentionally ignored.
 */

import type { JiraPluginConfig } from "./config.js";

export interface JiraIssueLink {
  type?: { name?: string };
  outwardIssue?: { key?: string };
  inwardIssue?: { key?: string };
}

export interface MappedLink {
  kind: "blocks" | "blockedBy";
  externalId: string;
}

export function mapLinkType(config: JiraPluginConfig, link: JiraIssueLink): MappedLink | null {
  const linkName = link.type?.name?.trim();
  if (!linkName) return null;

  const blocksName = config.blocksLinkTypeName.trim();
  const isBlockedByName = config.isBlockedByLinkTypeName.trim();

  if (linkName === blocksName) {
    const target = link.outwardIssue?.key;
    if (target) return { kind: "blocks", externalId: target };
    const inward = link.inwardIssue?.key;
    if (inward) return { kind: "blockedBy", externalId: inward };
  }

  if (linkName === isBlockedByName) {
    const inward = link.inwardIssue?.key;
    if (inward) return { kind: "blockedBy", externalId: inward };
    const outward = link.outwardIssue?.key;
    if (outward) return { kind: "blocks", externalId: outward };
  }

  return null;
}
