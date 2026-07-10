#!/usr/bin/env bash
# watchdog — PostToolUse + PostToolUseFailure hook
#
# Functions:
# 1. Repeat failure detection (warns at 3x consecutive)
# 2. Multi-edit tracking (warns every 3 edits)
# 3. Audit logging with session_id, exit code, duration
# 4. Git status change detection (only logs when status differs)
# 5. Test output summarization (only when >30 lines)
#
# stdin JSON: { "hook_event_name": "...", "tool_name": "...", "session_id": "...", ... }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
CWD=${cwd:-$(pwd)}

mkdir -p "${SHAZAM_WATCHDOG_DIR}" "${SHAZAM_LOG_DIR}"

# Log rotation: truncate files over 5000 lines, keep last 2000
rotate_log() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local lines
    lines=$(wc -l < "$file" 2>/dev/null || echo 0)
    if [[ "$lines" -gt 5000 ]]; then
      tail -n 2000 "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
    fi
  fi
}
rotate_log "${LOG_DIR}/bash-audit.log"
rotate_log "${LOG_DIR}/bash-fail.log"
rotate_log "${LOG_DIR}/git-status.log"

ts() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

# =========================================================================
# 1. BASH: failure detection + audit + git tracking
# =========================================================================
if [[ "$tool_name" == "Bash" ]]; then
  cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

  if [[ -n "$cmd" ]]; then
    # --- Failure detection ---
    normalized=$(echo "$cmd" | sed 's/timeout [0-9]*/timeout <N>/g; s|/tmp/[a-zA-Z0-9_.-]*|/tmp/<tmp>|g' | xargs echo 2>/dev/null || echo "$cmd")
    cmd_hash=$(echo "$normalized" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "$normalized" | cksum | cut -d' ' -f1)
    fail_file="${WATCHDOG_DIR}/fail_${cmd_hash}"

    if [[ "$hook_event" == "PostToolUseFailure" ]]; then
      count=0
      [[ -f "$fail_file" ]] && count=$(cat "$fail_file")
      count=$((count + 1))
      echo "$count" > "$fail_file"

      # Log to fail log (unified format)
      error_msg=$(echo "$INPUT" | jq -r '.error.message // "unknown"')
      echo "[$(ts)] [${session_id:0:8}] [${CWD}] cmd=${cmd:0:200} error=${error_msg:0:200}" >> "${LOG_DIR}/bash-fail.log"

      if [[ "$count" -ge 3 ]]; then
        echo "[watchdog] command failed ${count}x consecutively — consider a different approach"
      fi
    else
      # Success — reset failure counter
      [[ -f "$fail_file" ]] && rm -f "$fail_file"
    fi

    # --- Audit log (unified: session_id + event + cwd + cmd) ---
    tool_output=$(echo "$INPUT" | jq -r '.tool_output // ""')
    output_len=${#tool_output}
    echo "[$(ts)] [${hook_event}] [${session_id:0:8}] [${CWD}] out=${output_len}B ${cmd:0:300}" >> "${LOG_DIR}/bash-audit.log"

    # --- Git status change detection (only log when different from last) ---
    if [[ "$hook_event" == "PostToolUse" ]] && git rev-parse --git-dir > /dev/null 2>&1; then
      current_status=$(git status --short 2>/dev/null | head -20)
      last_status_file="${WATCHDOG_DIR}/last_git_status"
      last_status=""
      [[ -f "$last_status_file" ]] && last_status=$(cat "$last_status_file")

      if [[ "$current_status" != "$last_status" ]]; then
        echo "$current_status" > "$last_status_file"
        echo "[$(ts)] [${session_id:0:8}] [${CWD}]:" >> "${LOG_DIR}/git-status.log"
        echo "${current_status:-"(clean)"}" >> "${LOG_DIR}/git-status.log"
        echo "---" >> "${LOG_DIR}/git-status.log"
      fi
    fi
  fi
fi

# =========================================================================
# 2. FILE EDITS: multi-edit tracking
# =========================================================================
if [[ "$tool_name" == "WriteFile" || "$tool_name" == "StrReplaceFile" ]]; then
  if [[ "$hook_event" == "PostToolUse" ]]; then
    session_file="${WATCHDOG_DIR}/edits_${session_id:0:12}"
    edit_count=0
    [[ -f "$session_file" ]] && edit_count=$(cat "$session_file")
    edit_count=$((edit_count + 1))
    echo "$edit_count" > "$session_file"

    # Audit log for file edits
    file_path=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
    echo "[$(ts)] [${hook_event}] [${session_id:0:8}] [${CWD}] ${tool_name} ${file_path}" >> "${LOG_DIR}/bash-audit.log"

    if [[ "$edit_count" -ge 3 && $((edit_count % 3)) -eq 0 ]]; then
      echo "[watchdog] ${edit_count} files edited this session — run mcp__pi-shazam__shazam_impact to assess blast radius"
    fi
  fi
fi

# =========================================================================
# 3. Test output summarization (only when verbose)
# =========================================================================
if [[ "$hook_event" == "PostToolUse" && "$tool_name" == "Bash" ]]; then
  tool_output=$(echo "$INPUT" | jq -r '.tool_output // ""')
  if [[ -n "$tool_output" ]]; then
    line_count=$(echo "$tool_output" | wc -l)
    if [[ "$line_count" -ge 30 ]]; then
      if echo "$tool_output" | grep -qE '(test result:|Tests:[[:space:]]+[0-9]+|Test Files:[[:space:]]+[0-9]+|FAILED|PASS|pytest|^ok[[:space:]]+[0-9]+|^[0-9]+\.\.[0-9]+)'; then
        summary=$(echo "$tool_output" | grep -v '^$' | tail -5 | tr '\n' ' ' | sed 's/[[:space:]]*$//')
        [[ -n "$summary" ]] && [[ ${#summary} -le 300 ]] && echo "[watchdog] test summary: ${summary}"
      fi
    fi
  fi
fi

exit 0
