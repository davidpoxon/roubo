export function getToolErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Match shell "command not found" patterns, e.g. "/bin/sh: code: command not found"
  const match = message.match(/\/bin\/sh:\s*(\S+):\s*(?:command\s+)?not found/i);
  if (match) {
    const cmd = match[1];
    if (cmd === "code") {
      return "VS Code CLI not found. Open VS Code and run: Shell Command: Install 'code' command in PATH";
    }
    return `'${cmd}' not found on PATH. Check that the command is installed and available in your shell.`;
  }
  return message;
}
