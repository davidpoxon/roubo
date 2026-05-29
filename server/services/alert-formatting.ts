import type { NormalizedIssue, AssignedIssue } from "@roubo/shared";
import type { IssueContext } from "./issue-formatting.js";

// Builds the prompt body injected into a jig for an alert-backed bench. Reads
// ONLY from the already-redacted NormalizedIssue produced by the plugin's
// getIssue (FR-043, NFR-012): the literal secret has already been stripped, and
// this formatter never re-fetches or echoes any field that could carry it. The
// `raw` payload is the redacted clone, so reading it here is safe.

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCodeScanning(raw: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const rule = asRecord(raw.rule);
  const description = str(rule.description) ?? str(rule.name) ?? str(rule.id);
  if (description) lines.push(`**Rule:** ${description}`);
  if (str(rule.id)) lines.push(`**Rule id:** ${str(rule.id)}`);
  const severity = str(rule.security_severity_level) ?? str(rule.severity);
  if (severity) lines.push(`**Severity:** ${severity}`);
  const tool = str(asRecord(raw.tool).name);
  if (tool) lines.push(`**Tool:** ${tool}`);

  const instance = asRecord(raw.most_recent_instance);
  const location = asRecord(instance.location);
  const path = str(location.path);
  if (path) {
    const startLine = num(location.start_line);
    lines.push(`**Location:** ${path}${startLine !== undefined ? `:${startLine}` : ""}`);
  }
  const message = str(asRecord(instance.message).text);
  if (message) lines.push(`**Message:** ${message}`);
  return lines;
}

function formatSecretScanning(raw: Record<string, unknown>): string[] {
  const lines: string[] = [];
  // Deliberately surfaces only metadata; the literal secret is never read.
  const type = str(raw.secret_type_display_name) ?? str(raw.secret_type);
  if (type) lines.push(`**Secret type:** ${type}`);
  if (str(raw.validity)) lines.push(`**Validity:** ${str(raw.validity)}`);
  if (str(raw.resolution)) lines.push(`**Resolution:** ${str(raw.resolution)}`);
  if (raw.push_protection_bypassed === true) lines.push(`**Push protection bypassed:** yes`);
  return lines;
}

function formatDependabot(raw: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const advisory = asRecord(raw.security_advisory);
  if (str(advisory.summary)) lines.push(`**Advisory:** ${str(advisory.summary)}`);
  if (str(advisory.ghsa_id)) lines.push(`**GHSA:** ${str(advisory.ghsa_id)}`);
  const severity = str(advisory.severity) ?? str(asRecord(raw.security_vulnerability).severity);
  if (severity) lines.push(`**Severity:** ${severity}`);
  const pkg = asRecord(asRecord(raw.dependency).package);
  const pkgName = str(pkg.name);
  if (pkgName) {
    const ecosystem = str(pkg.ecosystem);
    lines.push(`**Package:** ${pkgName}${ecosystem ? ` (${ecosystem})` : ""}`);
  }
  const manifest = str(asRecord(raw.dependency).manifest_path);
  if (manifest) lines.push(`**Manifest:** ${manifest}`);
  const patched = str(
    asRecord(asRecord(raw.security_vulnerability).first_patched_version).identifier,
  );
  if (patched) lines.push(`**First patched version:** ${patched}`);
  return lines;
}

/**
 * Formats a security alert as a Markdown body for jig injection. The issueType
 * discriminates the category; unknown types fall back to the title only.
 */
export function formatAlertBody(
  issue: Pick<NormalizedIssue, "issueType" | "raw" | "externalUrl">,
): string {
  const raw = asRecord(issue.raw);
  let lines: string[];
  switch (issue.issueType) {
    case "security-code-scanning":
      lines = formatCodeScanning(raw);
      break;
    case "security-secret-scanning":
      lines = formatSecretScanning(raw);
      break;
    case "security-dependabot":
      lines = formatDependabot(raw);
      break;
    default:
      lines = [];
  }
  if (issue.externalUrl) lines.push(`**Alert URL:** ${issue.externalUrl}`);
  return lines.join("\n");
}

/**
 * Re-hydrates jig context for an alert-backed bench from its persisted, already
 * redacted `assignedIssue.raw`, reproducing the context the bench received at
 * creation. Used by the jig re-injection paths instead of fetching by number,
 * since an alert-backed bench's `number` is an alert number, not a GitHub issue
 * number. No network call and no leak risk: `formatAlertBody` reads only the
 * redacted clone, and `externalUrl` is recovered from `raw.html_url` (the same
 * field the plugin mapper used to set `NormalizedIssue.externalUrl`).
 */
export function buildAlertIssueContext(assignedIssue: AssignedIssue): IssueContext {
  const externalUrl = str(asRecord(assignedIssue.raw).html_url) ?? "";
  return {
    issueNumber: assignedIssue.number,
    issueTitle: assignedIssue.title,
    issueBody: formatAlertBody({
      issueType: assignedIssue.issueType ?? null,
      raw: assignedIssue.raw,
      externalUrl,
    }),
    issueUrl: externalUrl,
    comments: "",
  };
}
