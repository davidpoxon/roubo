import type { PermissionRule } from "./permissionTypes";

export function ruleKey(rule: PermissionRule): string {
  return `${rule.type}:${rule.pattern}`;
}

export function permissionsDiff(
  source: PermissionRule[],
  current: PermissionRule[],
): { newRules: PermissionRule[] } {
  const currentKeys = new Set(current.map(ruleKey));
  return { newRules: source.filter((r) => !currentKeys.has(ruleKey(r))) };
}

export function mergeWithSelection(
  current: PermissionRule[],
  newRules: PermissionRule[],
  selectedKeys: Set<string>,
): { merged: PermissionRule[]; addedKeys: Set<string> } {
  const currentKeys = new Set(current.map(ruleKey));
  const selected = newRules.filter((r) => selectedKeys.has(ruleKey(r)));
  const addedKeys = new Set(selected.map(ruleKey));
  const merged = [...current, ...selected.filter((r) => !currentKeys.has(ruleKey(r)))];
  return { merged, addedKeys };
}
