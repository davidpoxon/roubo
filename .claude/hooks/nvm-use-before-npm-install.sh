#!/usr/bin/env bash
# PreToolUse (Bash) hook: ensure the Node version pinned in .nvmrc is active before
# installing dependencies. nvm is a shell function, so we cannot set it from this
# subshell; instead we rewrite the Bash command to run `nvm use` in the same shell.
# Do not use set -e here: grep returns 1 (no match) for the common case and
# we must exit 0 to allow the Bash command to proceed.

input=$(cat 2>/dev/null) || input=""
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || command=""
[ -z "$command" ] && exit 0

# Match npm install / npm i / npm ci as a command token (start of line or after && ; |).
if printf '%s' "$command" | grep -qE '(^|&&|;|\|)[[:space:]]*npm[[:space:]]+(install|i|ci)([[:space:]]|$)'; then
  # Skip if nvm use is already part of the command (avoid double-prepend).
  if printf '%s' "$command" | grep -q 'nvm use'; then
    exit 0
  fi
  prefix='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use && '
  modified="${prefix}${command}"
  jq -n --arg cmd "$modified" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: $cmd }
    }
  }'
fi

exit 0
