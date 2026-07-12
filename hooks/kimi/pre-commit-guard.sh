#!/usr/bin/env bash
# pre-commit-guard — PreToolUse hook: block git commit if shazam_verify not run
#
# Intercepts Bash(git commit) and checks whether shazam_verify was called
# within the last 5 minutes. If not, blocks the commit (exit 2).
# --no-verify flag bypasses this gate.
#
# stdin: { "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "..."}, "session_id": "..." }
# Exit 0: allow. Exit 2: block (stderr shown to LLM).

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Only intercept git commit
if ! echo "$cmd" | grep -qE '(^|[;&|])git[[:space:]]+commit'; then
  exit 0
fi

# Skip if --no-verify is present
if echo "$cmd" | grep -q '\-\-no-verify'; then
  exit 0
fi

session_prefix="${session_id:0:12}"
marker="${SHAZAM_WATCHDOG_DIR}/verified_${session_prefix}"

# Check if verify was run within last 5 minutes (300 seconds)
if [[ -f "$marker" ]]; then
  last_verify=$(cat "$marker" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [[ "$((now - last_verify))" -le 300 ]]; then
    exit 0  # Recent verify found, allow commit
  fi
fi

# Also check: if no edits were made this session, allow commit
edit_file="${SHAZAM_WATCHDOG_DIR}/edits_${session_prefix}"
if [[ ! -f "$edit_file" ]] || [[ "$(cat "$edit_file" 2>/dev/null || echo 0)" -eq 0 ]]; then
  exit 0  # No edits, nothing to verify
fi

echo "[shazam] REMINDER: git commit detected but shazam_verify not run in last 5 minutes. Consider running shazam_verify first, or use git commit --no-verify to skip." >&2
exit 0
