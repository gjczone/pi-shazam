#!/usr/bin/env bash
# verify-marker — PostToolUse hook: record that shazam_verify was called
#
# Writes a timestamped marker file so other hooks (pre-commit-guard, stop-verify)
# can check whether verify has been run recently.
#
# stdin: { "hook_event_name": "PostToolUse", "tool_name": "...", "session_id": "..." }
# Exit 0: marker written.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$tool_name" != "mcp__pi-shazam__shazam_verify" ]]; then
  exit 0
fi

session_prefix="${session_id:0:12}"
mkdir -p "${SHAZAM_WATCHDOG_DIR}"

marker="${WATCHDOG_DIR}/verified_${session_prefix}"
# Write timestamp so pre-commit-guard can check recency
date +%s > "$marker"

exit 0
