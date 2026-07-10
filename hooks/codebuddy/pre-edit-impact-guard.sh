#!/usr/bin/env bash
# pre-edit-impact-guard — PreToolUse hook: auto-BLOCK code edits when impact pending
#
# After issue-guard.sh records a pending impact requirement, this hook checks
# before every Edit/Write/Bash operation and auto-blocks (exit 2).
# Exit 2 is an automatic deny — it NEVER triggers a permission prompt.
# The block stays active until shazam_impact clears the marker.
#
# Impact gate logic and degrade safety are sourced from lib/shazam-common.sh.
#
# stdin: { "hook_event_name": "PreToolUse", "tool_name": "Edit|Write|Bash", "tool_input": {...}, "session_id": "..." }
# Exit 0: allow. Exit 2: block (stderr shown to LLM as reason).

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

session_prefix="${session_id:0:12}"
marker="${SHAZAM_WATCHDOG_DIR}/pending_impact_${session_prefix}"

# Degrade safety: shazam known-unavailable → bypass impact gate
if shazam_is_unavailable; then
  echo "[guard] shazam impact gate bypassed: shazam unavailable (marker shazam_unavailable). Edits allowed; run shazam_impact manually or remove the marker once shazam recovers." >&2
  exit 0
fi

# No pending impact requirement → allow
[[ -f "$marker" ]] || exit 0

# Determine highest pending level
level=0
while IFS='=' read -r key val; do
  if [[ "$key" == "level" && "$val" -gt "$level" ]]; then
    level="$val"
  fi
done < "$marker"

# No level → nothing to enforce
[[ "$level" -ge 1 ]] || exit 0

# Only block code-changing tools
case "$tool_name" in
  Edit|Write)
    ;;
  Bash)
    cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
    if echo "$cmd" | grep -qE '(gh[[:space:]]+issue[[:space:]]+(close|edit))'; then
      :
    elif echo "$cmd" | grep -qE '(test|build|typecheck|lint|clippy|status|log|diff|show)'; then
      exit 0
    elif echo "$cmd" | grep -qE '(sed|awk|tee|cat.*EOF|>>)'; then
      :
    else
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac

# Build block message
case $level in
  2)
    cat >&2 <<'EOF'
BLOCKED: P0 issue created but required shazam analysis has NOT been run yet. Before editing code you MUST:
  1. shazam_impact — full blast radius analysis (all affected files/symbols)
  2. find . -name "*.test.*" -o -name "*_test.*" -o -name "test_*" — locate every related test file (shazam_find_tests is not available)
  3. shazam_impact --symbol — trace all callers/callees of changed symbols
Run them, then retry the edit.
EOF
    ;;
  1)
    cat >&2 <<'EOF'
BLOCKED: bug/refactor issue created but required shazam analysis has NOT been run yet. Before editing code you MUST:
  1. shazam_impact — blast radius across affected files
  2. find . -name "*.test.*" -o -name "*_test.*" -o -name "test_*" — identify test coverage gaps (shazam_find_tests is not available)
Run them, then retry the edit.
EOF
    ;;
esac

exit 2
