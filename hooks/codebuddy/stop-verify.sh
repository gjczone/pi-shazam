#!/usr/bin/env bash
# stop-verify — Stop hook: remind LLM to verify before ending
#
# When the model tries to end its turn, check if there were recent edits.
# Skips the reminder if the LLM already signaled shazam_verify completion
# via the verified marker file (see mcp-reference.sh VERIFY SIGNAL rule).
#
# stdin JSON: { "hook_event_name": "Stop", "session_id": "...", "cwd": "..." }
# Exit 0: allow (stdout appended to context).

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
CWD=${cwd:-$(pwd)}

session_prefix="${session_id:0:12}"

# Check if there were file edits this session
edit_file="${WATCHDOG_DIR}/edits_${session_prefix}"
edit_count=0
if [[ -f "$edit_file" ]]; then
  edit_count=$(cat "$edit_file" 2>/dev/null || echo 0)
fi

if [[ "$edit_count" -le 0 ]]; then
  exit 0
fi

# Check if shazam_verify was already signaled this session
verify_file="${WATCHDOG_DIR}/verified_${session_prefix}"
if [[ -f "$verify_file" ]]; then
  exit 0
fi

echo "[stop] ${edit_count} file(s) edited this session — run mcp__pi-shazam__shazam_verify to check for errors before finishing (if you already ran it, ignore this)"

exit 0
