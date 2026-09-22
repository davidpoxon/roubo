import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { Copy, ExternalLink } from "lucide-react";
import type { AgentCliStep } from "@roubo/shared";

const STRINGS = {
  copy: "Copy command",
  copied: "Copied",
  guide: { install: "Installation guide", update: "Update guide" },
};

/**
 * Only http and https open externally: the desktop shell's window-open handler
 * refuses every other scheme, so a link with one would do nothing when pressed.
 * The manifest schema already rejects them; this is the second guard, for a
 * value that reached the client some other way.
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * An agent plugin's declared install or update step for its CLI (APCC-NFR-003): the
 * command to copy, and a link to the plugin's instructions. The command is shown
 * and copied, never run. Shared by the launch-failure panel and the AI Agents
 * card, so both say the same thing about the same CLI.
 */
export default function CliRemedy({
  step,
  kind,
  testId,
}: {
  step: AgentCliStep;
  kind: "install" | "update";
  testId: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyCommand = () => {
    if (step.command === undefined) return;
    void navigator.clipboard.writeText(step.command);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const url = step.url !== undefined && isHttpUrl(step.url) ? step.url : undefined;
  if (step.command === undefined && url === undefined) return null;

  return (
    <div data-testid={testId} className="mt-2 space-y-1.5">
      {step.command !== undefined && (
        <div className="flex items-center gap-2 min-w-0 rounded bg-bg-surface px-2.5 py-1.5">
          <code
            data-testid={`${testId}-command`}
            className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-11 text-text-body"
          >
            {step.command}
          </code>
          <Button
            onPress={copyCommand}
            aria-label={STRINGS.copy}
            data-testid={`${testId}-copy`}
            className="shrink-0 text-text-secondary hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Copy size={12} aria-hidden="true" />
          </Button>
          {copied && (
            <span role="status" className="shrink-0 text-11 text-success-text">
              {STRINGS.copied}
            </span>
          )}
        </div>
      )}
      {url !== undefined && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`${testId}-link`}
          className="inline-flex items-center gap-1 text-11 font-medium text-accent-text hover:underline underline-offset-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ExternalLink size={12} aria-hidden="true" />
          {STRINGS.guide[kind]}
        </a>
      )}
    </div>
  );
}
