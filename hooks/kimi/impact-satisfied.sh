#!/usr/bin/env bash
# impact-satisfied — PostToolUse hook: clear pending impact marker
# when shazam_impact has been successfully called
#
# stdin: { "hook_event_name": "PostToolUse", "tool_name": "...", "session_id": "..." }
# Exit 0: marker cleared, context injected.

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only trigger on shazam_impact
if [[ "$tool_name" != "mcp__pi-shazam__shazam_impact" ]]; then
  exit 0
fi

session_prefix="${session_id:0:12}"
marker="${WATCHDOG_DIR}/pending_impact_${session_prefix}"

if [[ -f "$marker" ]]; then
  rm -f "$marker"
  echo "[guard] shazam_impact completed — pending impact requirement cleared, code edits now allowed"
fi

exit 0
