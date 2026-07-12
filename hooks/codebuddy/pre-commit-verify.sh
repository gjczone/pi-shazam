#!/usr/bin/env bash
# pre-commit-verify -- Non-blocking verify reminder on git commit
#
# Intercepts Bash(git commit) and outputs a reminder to run
# shazam_verify first. Does NOT block (exit 0).
#
# stdin: { "hook_event_name": "PreToolUse", "tool_name": "Bash",
#          "tool_input": {"command": "..."}, "session_id": "..." }
# Exit 0: allow (always).

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Only intercept git commit (without --no-verify)
if ! echo "$cmd" | grep -qE '(^|[;&|])git[[:space:]]+commit'; then
  exit 0
fi

# Skip if --no-verify is present
if echo "$cmd" | grep -q '\-\-no-verify'; then
  exit 0
fi

# Output reminder (attached to LLM context, does not block)
echo "[shazam] Commit detected -- run shazam_verify --preCommit first to catch type errors, lint issues, and broken references early."
exit 0
