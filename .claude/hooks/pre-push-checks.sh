#!/usr/bin/env bash
# PreToolUse (Bash) hook: run format/lint/typecheck before a git push.
# Do not use set -e here: grep returns 1 (no match) for the common case and
# we must exit 0 to allow the Bash command to proceed.

input=$(cat 2>/dev/null) || input=""
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || command=""
if printf '%s' "$command" | grep -q 'git push' 2>/dev/null; then
  npx prettier --check . && npm run lint && npm run typecheck
fi
exit 0
