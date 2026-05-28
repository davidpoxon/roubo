import { Button, Link } from "react-aria-components";
import type { GitHubErrorCode } from "@roubo/shared";
import { ApiError, getApiErrorParams } from "../lib/api";

// Plugin-RPC transport codes minted by `server/routes/plugin-rpc-error.ts`. They
// surface in the same UI as GitHub-domain codes because the cut-list pipes both
// through this component, but they describe transport / plugin-lifecycle state
// rather than GitHub itself, so they get their own copy.
type PluginErrorCode =
  | "rpc-error"
  | "rpc-init-failed"
  | "plugin-not-enabled"
  | "unknown-plugin"
  | "timeout";

interface ErrorCopy {
  code: GitHubErrorCode | PluginErrorCode | "GENERIC";
  title: string;
  description: string;
  primaryKind?: "connect" | "reconnect" | "link";
  primaryLabel?: string;
  primaryHref?: string;
  showSecondaryRetry?: boolean;
}

function resolveErrorCopy(error: unknown): ErrorCopy {
  if (!(error instanceof ApiError)) {
    const msg = error instanceof Error ? error.message : "An unknown error occurred";
    return { code: "GENERIC", title: "Could not load from GitHub", description: msg };
  }

  const params = getApiErrorParams(error);
  const code = error.code as GitHubErrorCode | PluginErrorCode | undefined;

  switch (code) {
    case "NOT_CONNECTED":
      return {
        code,
        title: "GitHub not connected",
        description: "Connect your GitHub account to load projects, issues, and cuts.",
        primaryKind: "connect",
        primaryLabel: "Connect GitHub",
      };
    case "SCOPES_OUTDATED":
      return {
        code,
        title: "Permissions out of date",
        description: "Roubo needs additional GitHub permissions to load this data.",
        primaryKind: "reconnect",
        primaryLabel: "Reconnect GitHub",
      };
    case "ORG_APPROVAL_REQUIRED": {
      const owner = params.owner ?? "";
      return {
        code,
        title: "Org approval required",
        description: owner
          ? `Roubo needs approval for the "${owner}" organization.`
          : "Roubo needs approval for your GitHub organization.",
        primaryKind: "link",
        primaryLabel: "Request approval",
        primaryHref: owner
          ? `https://github.com/organizations/${owner}/settings/oauth_application_policy`
          : undefined,
        showSecondaryRetry: true,
      };
    }
    case "SAML_SSO_REQUIRED": {
      const owner = params.owner ?? "";
      return {
        code,
        title: "SAML SSO authorization required",
        description: owner
          ? `Authorize your GitHub token for the "${owner}" organization's SAML SSO.`
          : "Authorize your GitHub token for your organization's SAML SSO.",
        primaryKind: "link",
        primaryLabel: "Authorize SSO",
        primaryHref: owner ? `https://github.com/orgs/${owner}/sso` : undefined,
        showSecondaryRetry: true,
      };
    }
    case "OWNER_NOT_FOUND":
      return {
        code,
        title: "Owner not found",
        description: "Check the repository owner in your roubo.yaml.",
        showSecondaryRetry: true,
      };
    case "RATE_LIMITED": {
      const sec = params.retryAfterSec ? ` in ${params.retryAfterSec}s` : "";
      return {
        code,
        title: "Rate limited by GitHub",
        description: `GitHub rate limit reached. Try again${sec}.`,
        showSecondaryRetry: true,
      };
    }
    case "NETWORK":
      return {
        code,
        title: "Can't reach GitHub",
        description: "Check your internet connection and try again.",
        showSecondaryRetry: true,
      };
    case "rpc-error":
      return {
        code,
        title: "Plugin error",
        description: error.message || "The integration plugin returned an error.",
        showSecondaryRetry: true,
      };
    case "rpc-init-failed":
      return {
        code,
        title: "Plugin failed to start",
        description: error.message || "The integration plugin failed to initialise.",
        showSecondaryRetry: true,
      };
    case "plugin-not-enabled":
    case "unknown-plugin":
      return {
        code,
        title: "Integration not available",
        description: "Enable the integration plugin to load issues.",
        primaryKind: "reconnect",
        primaryLabel: "Configure",
        showSecondaryRetry: true,
      };
    case "timeout":
      return {
        code,
        title: "Plugin timed out",
        description: error.message || "The plugin took too long to respond.",
        showSecondaryRetry: true,
      };
    default:
      return {
        code: "UNKNOWN",
        title: "Could not load from GitHub",
        description: error.message || "An unexpected error occurred.",
        showSecondaryRetry: true,
      };
  }
}

interface GitHubErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  // Invoked when the user clicks Connect/Reconnect. Callers wire this to the
  // github-com plugin Configure dialog so the OAuth flow happens in-plugin.
  onReconnect?: () => void;
  variant?: "banner" | "inline";
  className?: string;
}

export default function GitHubErrorState({
  error,
  onRetry,
  onReconnect,
  variant = "inline",
  className,
}: GitHubErrorStateProps) {
  // falsy guard: callers pass null/undefined when no error is present
  if (!error) return null;

  const copy = resolveErrorCopy(error);

  const primaryAction =
    (copy.primaryKind === "connect" || copy.primaryKind === "reconnect") && onReconnect ? (
      <Button onPress={onReconnect} className={primaryActionClass}>
        {copy.primaryLabel}
      </Button>
    ) : copy.primaryKind === "link" && copy.primaryHref ? (
      <Link
        href={copy.primaryHref}
        target="_blank"
        rel="noopener noreferrer"
        className={primaryActionClass}
      >
        {copy.primaryLabel}
      </Link>
    ) : null;

  const retryAction =
    onRetry && (copy.showSecondaryRetry || !primaryAction) ? (
      <Button
        onPress={onRetry}
        className="text-xs text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 outline-none transition-colors"
      >
        Retry
      </Button>
    ) : null;

  if (variant === "banner") {
    return (
      <div
        className={[
          "flex items-center justify-between gap-4 px-4 py-3 rounded-lg",
          "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50",
          className ?? "",
        ].join(" ")}
      >
        <div className="min-w-0">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{copy.title}</p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/70 mt-0.5 leading-relaxed">
            {copy.description}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {retryAction}
          {primaryAction}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="text-xs text-stone-500 dark:text-stone-500 mb-1">{copy.title}</p>
      <p className="text-xs text-stone-400 dark:text-stone-600 mb-2 leading-relaxed">
        {copy.description}
      </p>
      <div className="flex items-center gap-2">
        {retryAction}
        {primaryAction}
      </div>
    </div>
  );
}

const primaryActionClass = [
  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 outline-none no-underline shrink-0",
  "bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-stone-950",
  "focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950",
].join(" ");
