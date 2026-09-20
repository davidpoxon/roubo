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

/** Every tier the stored model carries, in the order the pickers offer them. */
export const RULE_TYPE_ITEMS = [
  { value: "allow", label: "allow" },
  { value: "deny", label: "deny" },
  { value: "ask", label: "ask" },
];

/** The tiers offered when the agent's capabilities have not answered yet. */
export const ALL_RULE_TYPES: RuleType[] = ["allow", "deny", "ask"];

/**
 * The tier vocabulary a picker may offer (#862, AP-FR-016). `honoured` is what
 * the project's agent declared it carries; `keep` is a tier the row being
 * edited already has, which stays on the list even when the agent does not
 * carry it, so editing such a rule's pattern never silently reassigns its tier.
 */
export function ruleTypeItemsFor(honoured: RuleType[], keep?: RuleType) {
  return RULE_TYPE_ITEMS.filter(
    (item) => honoured.includes(item.value as RuleType) || item.value === keep,
  );
}

export interface SelectionState {
  selectedKeys: Set<string>;
  onToggleKey: (key: string) => void;
}
