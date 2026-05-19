import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeSettings, ProjectPermissions } from "@roubo/shared";
import { atomicWrite } from "./state.js";

function mergePermissions(
  existing: string[] | undefined,
  project: string[] | undefined,
): string[] | undefined {
  if (!existing && !project) return undefined;
  const merged = [...new Set([...(existing ?? []), ...(project ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

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

export function writeClaudeSettingsLocal(
  workspacePath: string,
  claudeCodeSettings?: ClaudeCodeSettings,
  projectPermissions?: ProjectPermissions,
): void {
  const claudeDir = path.join(workspacePath, ".claude");
  const filePath = path.join(claudeDir, "settings.local.json");

  const existing = readExistingSettings(filePath);
  const existingPerms = extractExistingPerms(existing);
  const existingAllow = Array.isArray(existingPerms.allow)
    ? (existingPerms.allow as string[])
    : undefined;
  const existingDeny = Array.isArray(existingPerms.deny)
    ? (existingPerms.deny as string[])
    : undefined;

  // Start from existing permissions to preserve any unknown sub-keys
  const perms: Record<string, unknown> = { ...existingPerms };
  if (claudeCodeSettings?.enableAutoMode) {
    perms.defaultMode = "auto";
  } else {
    delete perms.defaultMode;
  }
  const mergedAllow = mergePermissions(existingAllow, projectPermissions?.allow);
  if (mergedAllow) {
    perms.allow = mergedAllow;
  } else {
    delete perms.allow;
  }
  const mergedDeny = mergePermissions(existingDeny, projectPermissions?.deny);
  if (mergedDeny) {
    perms.deny = mergedDeny;
  } else {
    delete perms.deny;
  }
  const existingAsk = Array.isArray(existingPerms.ask)
    ? (existingPerms.ask as string[])
    : undefined;
  const mergedAsk = mergePermissions(existingAsk, projectPermissions?.ask);
  if (mergedAsk) {
    perms.ask = mergedAsk;
  } else {
    delete perms.ask;
  }
  if (Object.keys(perms).length > 0) {
    existing.permissions = perms;
  } else {
    delete existing.permissions;
  }

  // Always overwrite hooks — Roubo's notification endpoint must be registered on every
  // session start. User-defined Notification hooks are intentionally not merged.
  // Catch-all (no matcher): every Notification event Claude Code emits POSTs to Roubo.
  // Over-notification self-corrects via dismissWaitingNotificationsForSession when
  // fresh PTY output arrives.
  const port = process.env.ROUBO_PORT || "3335";
  const hookUrl = `http://localhost:${port}/api/hooks/claude-notification`;
  existing.hooks = {
    Notification: [{ hooks: [{ type: "http", url: hookUrl }] }],
  };

  fs.mkdirSync(claudeDir, { recursive: true });
  atomicWrite(filePath, JSON.stringify(existing, null, 2));
}

// Additive merge: unions project rules with whatever already exists in the bench workspace.
// Existing rules are never removed — deletion of a project rule only takes effect when the bench is cleared.
export function injectPermissions(workspacePath: string, permissions: ProjectPermissions): void {
  const permAsk = permissions.ask ?? [];
  // Empty project rules means nothing to inject; removal is not propagated by resync.
  if (permissions.allow.length === 0 && permissions.deny.length === 0 && permAsk.length === 0)
    return;

  const claudeDir = path.join(workspacePath, ".claude");
  const filePath = path.join(claudeDir, "settings.local.json");

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

  fs.mkdirSync(claudeDir, { recursive: true });
  atomicWrite(filePath, JSON.stringify(existing, null, 2));
}
