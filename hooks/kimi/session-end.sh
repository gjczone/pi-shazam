#!/usr/bin/env bash
# SessionEnd hook: session summary with actionable insights
#
# Upgraded from basic stat logging to shazam-style actionable output:
# - Test pass/fail rate from watchdog data
# - Top failure patterns
# - Uncommitted changes reminder
# - Session duration estimate
#
# stdin JSON: { "hook_event_name": "SessionEnd", "matcher_value": "exit", "session_id": "..." }
# Exit 0: allow.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
matcher_value=$(echo "$INPUT" | jq -r '.matcher_value // "exit"')
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
CWD=${cwd:-$(pwd 2>/dev/null || echo "unknown")}

AUDIT_DIR="${SHAZAM_LOG_DIR}"
SESSIONS_DIR="${AUDIT_DIR}/sessions"
mkdir -p "$SESSIONS_DIR"

TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S%z')
TODAY=$(date '+%Y-%m-%d')
SESSION_LOG="${SESSIONS_DIR}/session-$(date '+%Y%m%d').log"

# --- Statistics ---
BASH_TOTAL=0
BASH_FAIL=0
BASH_BLOCKED=0
EDIT_COUNT=0

[[ -f "${AUDIT_DIR}/bash-audit.log" ]] && BASH_TOTAL=$(grep -cF "[${TODAY}" "${AUDIT_DIR}/bash-audit.log" 2>/dev/null || echo 0)
[[ -f "${AUDIT_DIR}/bash-fail.log" ]] && BASH_FAIL=$(grep -cF "[${TODAY}" "${AUDIT_DIR}/bash-fail.log" 2>/dev/null || echo 0)
[[ -f "${AUDIT_DIR}/bash-blocked.log" ]] && BASH_BLOCKED=$(grep -cF "[${TODAY}" "${AUDIT_DIR}/bash-blocked.log" 2>/dev/null || echo 0)

# Count edits from this session only (not all sessions)
session_prefix="${session_id:0:12}"
edit_file="${WATCHDOG_DIR}/edits_${session_prefix}"
if [[ -f "$edit_file" ]]; then
  EDIT_COUNT=$(cat "$edit_file" 2>/dev/null || echo 0)
fi

# --- Failure rate ---
FAIL_RATE="0%"
if [[ "$BASH_TOTAL" -gt 0 ]]; then
  FAIL_RATE="$(( BASH_FAIL * 100 / BASH_TOTAL ))%"
fi

# --- Top failure patterns ---
TOP_FAILURES=""
if [[ -f "${AUDIT_DIR}/bash-fail.log" ]]; then
  TOP_FAILURES=$(grep "error=" "${AUDIT_DIR}/bash-fail.log" 2>/dev/null \
    | sed 's/.*error=//' \
    | sort | uniq -c | sort -rn | head -3 \
    | sed 's/^/  /' || true)
fi

# --- Write session log ---
{
  echo "=== Session End: ${TIMESTAMP} ==="
  echo "Session: ${session_id:0:12} (${matcher_value})"
  echo "Project: ${CWD}"
  echo ""
  echo "--- Today's Statistics ---"
  echo "Bash commands:   ${BASH_TOTAL}"
  echo "Failures:        ${BASH_FAIL} (${FAIL_RATE})"
  echo "Blocked:         ${BASH_BLOCKED}"
  echo "Files edited:    ${EDIT_COUNT}"

  if [[ -n "$TOP_FAILURES" ]]; then
    echo ""
    echo "--- Top Failure Patterns ---"
    echo "$TOP_FAILURES"
  fi

  # Git state
  if git rev-parse --git-dir > /dev/null 2>&1; then
    uncommitted=$(git status --short 2>/dev/null | wc -l)
    if [[ "$uncommitted" -gt 0 ]]; then
      echo ""
      echo "--- Uncommitted Changes (${uncommitted} files) ---"
      git status --short 2>/dev/null | head -10
      [[ "$uncommitted" -gt 10 ]] && echo "  ... and $((uncommitted - 10)) more"
      echo "  [REMINDER] Run mcp__pi-shazam__shazam_verify before committing"
    fi

    echo ""
    echo "--- Recent Commits ---"
    git log --oneline -5 2>/dev/null || echo "(none)"
  fi

  echo "================================"
  echo ""
} >> "$SESSION_LOG"

# Cleanup watchdog session files
rm -f "${WATCHDOG_DIR}/edits_${session_prefix}" 2>/dev/null
rm -f "${WATCHDOG_DIR}/verified_${session_prefix}" 2>/dev/null
rm -f "${WATCHDOG_DIR}/init_${session_prefix}" 2>/dev/null
rm -f "${WATCHDOG_DIR}/pending_impact_${session_prefix}" 2>/dev/null
rm -f "${WATCHDOG_DIR}/issues_${session_prefix}" 2>/dev/null
rm -f "${WATCHDOG_DIR}/stop_fail_${session_prefix}" 2>/dev/null

exit 0
