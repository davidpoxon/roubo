import type { ProjectPermissions } from "@roubo/shared";
import type { RuleType, PermissionRule } from "./permissionTypes";

export type { RuleType, PermissionRule } from "./permissionTypes";

export function flattenPermissions(permissions: ProjectPermissions): PermissionRule[] {
  return [
    ...permissions.allow.map((p) => ({
      type: "allow" as RuleType,
      pattern: p,
    })),
    ...permissions.deny.map((p) => ({ type: "deny" as RuleType, pattern: p })),
    ...(permissions.ask ?? []).map((p) => ({
      type: "ask" as RuleType,
      pattern: p,
    })),
  ];
}

export const RULE_TYPE_ITEMS = [
  { value: "allow", label: "allow" },
  { value: "deny", label: "deny" },
  { value: "ask", label: "ask" },
];

export interface SelectionState {
  selectedKeys: Set<string>;
  onToggleKey: (key: string) => void;
}
