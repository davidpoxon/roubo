import fs from "node:fs";
import path from "node:path";
import type { ProjectPermissions } from "@roubo/shared";
import { atomicWrite } from "./state.js";

function readExistingSettings(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractExistingPerms(existing: Record<string, unknown>): Record<string, unknown> {
  return existing.permissions !== null &&
    typeof existing.permissions === "object" &&
    !Array.isArray(existing.permissions)
    ? (existing.permissions as Record<string, unknown>)
    : {};
}

// Additive merge: unions project rules with whatever already exists in the bench workspace.
// Existing rules are never removed: deletion of a project rule only takes effect when the bench is cleared.
export function injectPermissions(workspacePath: string, permissions: ProjectPermissions): void {
  const permAsk = permissions.ask ?? [];
  // Empty project rules means nothing to inject; removal is not propagated by resync.
  if (permissions.allow.length === 0 && permissions.deny.length === 0 && permAsk.length === 0)
    return;

  const settingsDir = path.join(workspacePath, ".claude");
  const filePath = path.join(settingsDir, "settings.local.json");

  const existing = readExistingSettings(filePath);
  const existingPerms = extractExistingPerms(existing);
  const existingAllow = Array.isArray(existingPerms.allow)
    ? (existingPerms.allow as string[])
    : undefined;
  const existingDeny = Array.isArray(existingPerms.deny)
    ? (existingPerms.deny as string[])
    : undefined;
  const existingAsk = Array.isArray(existingPerms.ask)
    ? (existingPerms.ask as string[])
    : undefined;

  const mergedAllow = [...new Set([...(existingAllow ?? []), ...permissions.allow])];
  const mergedDeny = [...new Set([...(existingDeny ?? []), ...permissions.deny])];
  const mergedAsk = [...new Set([...(existingAsk ?? []), ...permAsk])];

  const perms: Record<string, unknown> = { ...existingPerms };
  if (mergedAllow.length > 0) {
    perms.allow = mergedAllow;
  } else {
    delete perms.allow;
  }
  if (mergedDeny.length > 0) {
    perms.deny = mergedDeny;
  } else {
    delete perms.deny;
  }
  if (mergedAsk.length > 0) {
    perms.ask = mergedAsk;
  } else {
    delete perms.ask;
  }

  if (Object.keys(perms).length > 0) {
    existing.permissions = perms;
  } else {
    delete existing.permissions;
  }

  fs.mkdirSync(settingsDir, { recursive: true });
  atomicWrite(filePath, JSON.stringify(existing, null, 2));
}
