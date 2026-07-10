#!/usr/bin/env bash
# issue-guard — PostToolUse hook: track created issues and their required follow-ups
#
# When a P0/P1/bug issue is created without impact analysis, this hook writes a
# marker file that downstream PreToolUse hooks read to BLOCK code edits until
# shazam_impact has been run.
#
# Updated for pi-shazam v0.23.x tool set (7 tools):
#   shazam_find_tests was REMOVED — replaced with Bash `find` for test discovery.
#   This is intentional: shazam_find_tests overlapped with built-in find for most
#   common patterns, and removing it simplifies the tool surface.
#
# stdin: { "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "..."}, "session_id": "..." }
# Exit 0: marker written for enforcement; stdout injected as context reminder.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

if ! echo "$cmd" | grep -qE '(^|[;&|])gh[[:space:]]+issue[[:space:]]+create'; then
  exit 0
fi

session_prefix="${session_id:0:12}"
mkdir -p "${SHAZAM_WATCHDOG_DIR}"

# ── Determine required follow-up level ──
# 0 = none (docs, chore), 1 = normal (bug/feature → impact + locate tests),
# 2 = critical (P0 → impact + locate tests + impact --symbol)
# NOTE: shazam_find_tests was is not available. Use Bash find for test discovery.
level=0

if echo "$cmd" | grep -qiE '(P0|security|crash|panic|auth.bypass|data.loss)'; then
  level=2
elif echo "$cmd" | grep -qiE '(P1|fix:|bug|race.condition|logic.error|regression)'; then
  level=1
elif echo "$cmd" | grep -qiE '(refactor|extract|dedup|rename|move)'; then
  level=1
fi

# ── Track pending impact requirement ──
if [[ "$level" -ge 1 ]]; then
  marker="${WATCHDOG_DIR}/pending_impact_${session_prefix}"
  # Append issue info to marker (cumulative across session)
  echo "level=${level}" >> "$marker"
fi

# ── Session-level count ──
counter_file="${WATCHDOG_DIR}/issues_${session_prefix}"
touch "$counter_file"
count=$(wc -l < "$counter_file")
echo "1" >> "$counter_file"
count=$((count + 1))

# ── Context reminder (stdout injected to LLM) ──
# NOTE: shazam_find_tests is not available → use Bash `find` to locate test files.
case $level in
  2)
    cat <<'EOF'
> [BLOCKED] P0 issue created. Before ANY code change, you MUST:
>    1. `shazam_impact` — full blast radius analysis (all affected files/symbols)
>    2. `find . -name "*.test.*" -o -name "*_test.*" -o -name "test_*"` — locate every related test file (shazam_find_tests was is not available)
>    3. `shazam_impact --symbol` — trace all callers/callees of changed symbols
>    Consequence: code edits will be BLOCKED until these run.
EOF
    ;;
  1)
    cat <<'EOF'
> [REQUIRED] Bug/refactor issue created. Before editing, you MUST:
>    1. `shazam_impact` — blast radius across affected files
>    2. `find . -name "*.test.*" -o -name "*_test.*" -o -name "test_*"` — identify test coverage gaps (shazam_find_tests was is not available)
>    Consequence: code edits will be BLOCKED until these run.
EOF
    ;;
  0)
    if [[ "$count" -eq 1 ]]; then
      echo "> Issue created. Consider: shazam_impact + locate tests via Bash find if this involves code changes."
    fi
    ;;
esac

exit 0
