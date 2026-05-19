export type RuleType = "allow" | "deny" | "ask";

export interface PermissionRule {
  type: RuleType;
  pattern: string;
}
