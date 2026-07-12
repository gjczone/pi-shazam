#!/usr/bin/env bash
# stop-failure — (NOT REGISTERED on CodeBuddy)
#
# CodeBuddy has no StopFailure event, so this hook is intentionally NOT wired
# into settings.json. Its failure-detection role is covered by:
#   - watchdog.sh   (PostToolUse Bash failure counting + repeated-failure warning)
#   - mcp-health.sh (PostToolUse MCP tool failure fallback suggestions)
# Keep this file for reference / future use if CodeBuddy adds StopFailure.
#
# Reference behavior (ported from kimi-code, adapted to codebuddy): log errors and suggest alternatives:
# When the model's turn fails (tool error, rate limit, etc.), log the
# failure pattern and suggest recovery actions. Enhanced with error-type
# analysis: reads recent failure logs from watchdog to provide targeted
# suggestions (file-not-found, permission-denied, network, module-missing).
#
# Updated for tool consolidation 14→9: file_detail/codesearch → lookup.
#
# stdin JSON: { "hook_event_name": "StopFailure", "matcher_value": "error_type", "session_id": "...", ... }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
error_type=$(echo "$INPUT" | jq -r '.matcher_value // "unknown"')
CWD=${cwd:-$(pwd)}

mkdir -p "${SHAZAM_LOG_DIR}" "${SHAZAM_WATCHDOG_DIR}"

ts() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

# ── analyze_error: categorize error message and return human-readable description ──
# Reads the most recent error line from bash-fail.log for this session.
analyze_error() {
  local fail_log="${LOG_DIR}/bash-fail.log"
  local recent=""
  if [[ -f "$fail_log" ]]; then
    recent=$(grep "${session_id:0:8}" "$fail_log" 2>/dev/null | tail -1 || true)
  fi

  # If we have a recent error from watchdog, analyze it
  if [[ -n "$recent" ]]; then
    local lower
    lower=$(echo "$recent" | tr '[:upper:]' '[:lower:]')

    if echo "$lower" | grep -qE 'file not found|enoent|no such file'; then
      echo "The error is: file not found. The target path may be incorrect."
      return
    fi
    if echo "$lower" | grep -qE 'permission denied|eacces|not permitted'; then
      echo "The error is: permission denied. Check file access rights."
      return
    fi
    if echo "$lower" | grep -qE 'enotfound|econnrefused|etimedout|network|resolve'; then
      echo "The error is: network issue. The remote resource may be unavailable."
      return
    fi
    if echo "$lower" | grep -qE 'cannot find module|cannot find package|module not found'; then
      echo "The error is: module/package not found. Check dependencies."
      return
    fi
    if echo "$lower" | grep -qE 'type.*error|syntax.*error|tsc|eslint|ruff'; then
      echo "The error is: type/syntax error. Run shazam_verify to check."
      return
    fi
    if echo "$lower" | grep -qE 'timeout|timed out'; then
      echo "The error is: timeout. The operation took too long."
      return
    fi
  fi

  # Fallback: use error_type for generic description
  case "$1" in
    *tool*|*Tool*) echo "The error is: tool execution failure." ;;
    *rate*|*Rate*) echo "The error is: rate limit." ;;
    *context*|*Context*) echo "The error is: context overflow." ;;
    *) echo "Repeated failures detected." ;;
  esac
}

# ── get_specific_suggestion: return targeted suggestion based on error pattern ──
get_specific_suggestion() {
  local fail_log="${LOG_DIR}/bash-fail.log"
  local recent=""
  if [[ -f "$fail_log" ]]; then
    recent=$(grep "${session_id:0:8}" "$fail_log" 2>/dev/null | tail -1 || true)
  fi

  if [[ -n "$recent" ]]; then
    local lower
    lower=$(echo "$recent" | tr '[:upper:]' '[:lower:]')

    if echo "$lower" | grep -qE 'file not found|enoent|no such file'; then
      echo "[stop-failure] file not found error repeated — try:"
      echo "  - Run mcp__pi-shazam__shazam_lookup to check if the target file exists"
      echo "  - Use grep -rn to locate the file by content"
      echo "  - Check if the file was renamed, moved, or deleted"
      return 0
    fi

    if echo "$lower" | grep -qE 'permission denied|eacces|not permitted'; then
      echo "[stop-failure] permission denied error repeated — try:"
      echo "  - Check file/directory permissions (ls -la)"
      echo "  - Ensure the path is writable"
      echo "  - Run with appropriate privileges if needed"
      return 0
    fi

    if echo "$lower" | grep -qE 'enotfound|econnrefused|etimedout|network|resolve'; then
      echo "[stop-failure] network error repeated — try:"
      echo "  - Check your network connection"
      echo "  - Verify the URL or remote host is accessible"
      echo "  - Retry with a longer timeout"
      return 0
    fi

    if echo "$lower" | grep -qE 'cannot find module|cannot find package|module not found'; then
      echo "[stop-failure] module not found error repeated — try:"
      echo "  - Run npm install / pip install to install dependencies"
      echo "  - Check import paths are correct"
      echo "  - Verify the package exists in package.json / requirements.txt"
      return 0
    fi
  fi

  return 1
}

# Log the failure
echo "[$(ts)] [${session_id:0:8}] [${CWD}] type=${error_type}" >> "${LOG_DIR}/stop-failures.log"

# Track consecutive failures
fail_count_file="${WATCHDOG_DIR}/stop_fail_${session_id:0:12}"
count=0
[[ -f "$fail_count_file" ]] && count=$(cat "$fail_count_file")
count=$((count + 1))
echo "$count" > "$fail_count_file"

# ── Suggestion logic ──

# After 5 failures: strong intervention with error analysis
if [[ "$count" -ge 5 ]]; then
  analysis=$(analyze_error "$error_type")
  echo "[stop-failure] turn failed ${count}x consecutively."
  echo ""
  echo "${analysis}"
  echo ""
  echo "Consider:"
  echo "  1. Run mcp__pi-shazam__shazam_overview to reorient yourself"
  echo "  2. Simplify the current task or break it into smaller steps"
  echo "  3. Ask the user for clarification"
  exit 0
fi

# After 3 failures: try specific error-pattern suggestions first
if [[ "$count" -ge 3 ]]; then
  if get_specific_suggestion; then
    exit 0
  fi

  # Fallback: tool-type-based suggestions
  case "$error_type" in
    *tool*|*Tool*)
      echo "[stop-failure] tool error repeated ${count}x — run mcp__pi-shazam__shazam_verify to check project health, or try mcp__pi-shazam__shazam_lookup instead of grep/find"
      ;;
    *rate*|*Rate*)
      echo "[stop-failure] rate limited ${count}x — wait 30s before retrying, or reduce request complexity"
      ;;
    *context*|*Context*)
      echo "[stop-failure] context issue repeated ${count}x — run mcp__pi-shazam__shazam_overview to reload project state, or start a fresh session"
      ;;
    *)
      echo "[stop-failure] turn failed ${count}x — consider running mcp__pi-shazam__shazam_overview to reorient"
      ;;
  esac
  exit 0
fi

# 1-2 failures: brief suggestion based on error type
case "$error_type" in
  *tool*|*Tool*)
    echo "[stop-failure] tool error — check mcp__pi-shazam__shazam_verify for project health"
    ;;
  *rate*|*Rate*)
    echo "[stop-failure] rate limited — wait a moment before retrying"
    ;;
  *context*|*Context*)
    echo "[stop-failure] context issue — run mcp__pi-shazam__shazam_overview to reload project state"
    ;;
  *)
    # Silent for unknown single errors — don't add noise
    ;;
esac

exit 0
