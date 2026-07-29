// Permission rule guard (issue #514, AP-FR-016, AP-NFR-001, AP-TC-081).
//
// A permission rule is an opaque string as far as core is concerned: the
// agent-launch descriptor contract is explicit that core "stores, unions, and
// injects rule strings; it never parses them", so no agent's rule vocabulary
// (`Read(...)`, `Bash(...)`, `mcp__*`, an approval policy name, anything) may
// leak into these types.
//
// That leaves exactly one thing core can still check without knowing the
// vocabulary: whether a rule NAMES A PATH THAT LEAVES THE BENCH WORKSPACE. A
// rule is text, but a path-escaping token inside it (`../../../../etc/**`, or a
// filesystem root like `/etc/**` or `~/.ssh/**`) means the same thing to every
// agent that reads paths at all, and it is the one thing that can grant reach
// outside the workspace the containment barriers in agent-launch-executor
// otherwise guarantee.
//
// So the check is deliberately lexical and vocabulary-free: find `..` used as a
// path segment, or an absolute/home-rooted path root, anywhere in the string.
// Everything else passes through untouched.
//
// This is the *rule* half of AP-NFR-001's confinement. The *file* half (the
// settings file a rule is written into never escaping the workspace) is already
// guaranteed by resolveWithin + assertRealpathWithin in agent-launch-executor.

/** A rule rejected because it names a path outside the bench workspace. */
export class PermissionRuleError extends Error {
  constructor(
    message: string,
    public readonly rule: string,
  ) {
    super(message);
    this.name = "PermissionRuleError";
  }
}

// A `..` used as a path segment: preceded by a path separator, a delimiter, or
// the start of the string, and followed by a separator, a delimiter, or the end.
// `Read(../../etc/**)`, `Bash(cd ..)` and `foo/../bar` all match; `a..b`,
// `WebFetch(domain:example..com)` and an ordinary ellipsis do not.
const TRAVERSAL_SEGMENT = /(?:^|[/\\\s(,:;"'=])\.\.(?:[/\\\s),;"']|$)/;

// A filesystem root: a leading `/` or `\`, a `~` home reference, or a Windows
// drive letter, at the start of the string or of any token inside it.
const ABSOLUTE_ROOT = /(?:^|[\s(,;"'=])(?:[/\\]|~[/\\]?|[A-Za-z]:[/\\])/;

/**
 * Why this rule cannot be stored, or `undefined` when it is safe. Returning the
 * reason rather than a boolean keeps the 400 the API surfaces specific enough
 * for the editor to point at the offending rule.
 */
export function describeUnsafeRule(rule: string): string | undefined {
  if (TRAVERSAL_SEGMENT.test(rule)) {
    return 'it contains a ".." path segment, which can reach outside the bench workspace';
  }
  if (ABSOLUTE_ROOT.test(rule)) {
    return "it names an absolute or home-rooted path, which is outside the bench workspace";
  }
  return undefined;
}

/** Whether a rule string is safe to store and inject. */
export function isSafeRule(rule: string): boolean {
  return describeUnsafeRule(rule) === undefined;
}

/**
 * Throw on the first path-escaping rule in any of the three arrays. Used at the
 * API boundary so an escaping pattern is rejected at the point the user adds it
 * (AP-TC-081 S001) rather than silently stored.
 */
export function assertSafeRules(groups: Record<string, string[] | undefined>): void {
  for (const [group, rules] of Object.entries(groups)) {
    for (const rule of rules ?? []) {
      const reason = describeUnsafeRule(rule);
      if (reason) {
        throw new PermissionRuleError(
          `Permission rule ${JSON.stringify(rule)} in "${group}" was rejected because ${reason}.`,
          rule,
        );
      }
    }
  }
}

/**
 * Drop every path-escaping rule from a stored set. Belt and braces for the write
 * path: a rules file persisted before this guard existed (or edited by hand)
 * must still not put an escaping pattern into a bench workspace on resync
 * (AP-TC-081 S002).
 */
export function filterSafeRules<T extends { allow: string[]; deny: string[]; ask?: string[] }>(
  permissions: T,
): T {
  return {
    ...permissions,
    allow: permissions.allow.filter(isSafeRule),
    deny: permissions.deny.filter(isSafeRule),
    ...(permissions.ask !== undefined && { ask: permissions.ask.filter(isSafeRule) }),
  };
}
