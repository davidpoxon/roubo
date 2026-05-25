import type { NormalizedIssue } from "@roubo/plugin-sdk";
import type { RawCodeScanningAlert } from "./alerts/code-scanning.js";
import type { RawDependabotAlert } from "./alerts/dependabot.js";
import type { RawSecretScanningAlert } from "./alerts/secret-scanning.js";
import { formatAlertExternalId } from "./external-id.js";
import { redactCodeScanningAlert, redactSecretScanningAlert } from "./redact.js";

// FR-043: issueType strings the host uses to route security alerts through
// the alert-only cut-list bucket and to gate UI controls per FR-048.
export const CODE_SCANNING_ISSUE_TYPE = "security-code-scanning";
export const SECRET_SCANNING_ISSUE_TYPE = "security-secret-scanning";
export const DEPENDABOT_ISSUE_TYPE = "security-dependabot";

function commonAlertFields(): Pick<
  NormalizedIssue,
  "body" | "currentState" | "allowedTransitions" | "assignees" | "labels" | "blocks" | "blockedBy"
> {
  return {
    body: null,
    currentState: "open",
    // FR-048: alerts are read-only — no host-mediated state changes, no assignment.
    allowedTransitions: [],
    assignees: [],
    labels: [],
    blocks: [],
    blockedBy: [],
  };
}

export function mapCodeScanningAlertToNormalizedIssue(
  integrationId: string,
  repoFullName: string,
  raw: RawCodeScanningAlert,
): NormalizedIssue {
  const redacted = redactCodeScanningAlert(raw);
  const title =
    redacted.rule?.description ??
    redacted.rule?.name ??
    redacted.rule?.id ??
    `Code scanning alert #${redacted.number}`;
  return {
    integrationId,
    externalId: formatAlertExternalId(repoFullName, "code-scanning", redacted.number),
    externalUrl: redacted.html_url,
    title,
    issueType: CODE_SCANNING_ISSUE_TYPE,
    updatedAt: redacted.updated_at ?? redacted.created_at,
    raw: redacted,
    ...commonAlertFields(),
  };
}

export function mapSecretScanningAlertToNormalizedIssue(
  integrationId: string,
  repoFullName: string,
  raw: RawSecretScanningAlert,
): NormalizedIssue {
  const redacted = redactSecretScanningAlert(raw);
  const title =
    redacted.secret_type_display_name ??
    redacted.secret_type ??
    `Secret scanning alert #${redacted.number}`;
  return {
    integrationId,
    externalId: formatAlertExternalId(repoFullName, "secret-scanning", redacted.number),
    externalUrl: redacted.html_url,
    title,
    issueType: SECRET_SCANNING_ISSUE_TYPE,
    updatedAt: redacted.updated_at ?? redacted.created_at,
    raw: redacted,
    ...commonAlertFields(),
  };
}

export function mapDependabotAlertToNormalizedIssue(
  integrationId: string,
  repoFullName: string,
  raw: RawDependabotAlert,
): NormalizedIssue {
  // Dependabot alerts carry no secret material or embedded snippets, so the
  // payload passes through unmodified; we still spread into a fresh object so
  // the mapper never hands the caller a reference into the API response.
  const cloned: RawDependabotAlert = { ...raw };
  const title =
    cloned.security_advisory?.summary ??
    `Dependabot alert #${cloned.number} (${cloned.dependency?.package?.name ?? "unknown package"})`;
  return {
    integrationId,
    externalId: formatAlertExternalId(repoFullName, "dependabot", cloned.number),
    externalUrl: cloned.html_url,
    title,
    issueType: DEPENDABOT_ISSUE_TYPE,
    updatedAt: cloned.updated_at ?? cloned.created_at,
    raw: cloned,
    ...commonAlertFields(),
  };
}
