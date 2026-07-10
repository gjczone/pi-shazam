#!/usr/bin/env bash
# shazam-common.sh — shared lib for pi-shazam MCP hooks
#
# This file is SOURCED by platform-specific hook scripts (CodeBuddy / Kimi Code).
# It provides:
#   - Platform auto-detection (watchdog/log paths differ between CodeBuddy / Kimi)
#   - Shared tool reference text (function shazam_tool_reference)
#   - Shared constants (SHAZAM_TOOL_COUNT, etc.)
#
# Usage in caller script (place after "set -eu"):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
#
# Requirements: set -eu compatible — all optional vars use ${VAR:-default}.

set -eu

# ── Platform auto-detection ──
# CodeBuddy:  ~/.codebuddy/hooks/            (watchdog at hooks/watchdog, log at hooks/log)
# Kimi Code:  ~/.kimi-code/hooks/            (watchdog at watchdog/, log at hooks-log/)

_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$_HOOK_DIR" == *".codebuddy/hooks"* ]]; then
  SHAZAM_ROOT="${_HOOK_DIR%/hooks}"
  SHAZAM_WATCHDOG_DIR="${SHAZAM_WATCHDOG_DIR:-$SHAZAM_ROOT/hooks/watchdog}"
  SHAZAM_LOG_DIR="${SHAZAM_LOG_DIR:-$SHAZAM_ROOT/hooks/log}"
elif [[ "$_HOOK_DIR" == *".kimi-code/hooks"* ]]; then
  SHAZAM_ROOT="${_HOOK_DIR%/hooks}"
  SHAZAM_WATCHDOG_DIR="${SHAZAM_WATCHDOG_DIR:-$SHAZAM_ROOT/watchdog}"
  SHAZAM_LOG_DIR="${SHAZAM_LOG_DIR:-$SHAZAM_ROOT/hooks-log}"
fi

# ── Constants ──

SHAZAM_TOOL_COUNT="${SHAZAM_TOOL_COUNT:-7}"

# ── Shared functions ──

# shazam_tool_reference [session_prefix]
# Output the complete pi-shazam MCP tool reference block.
# session_prefix: first 12 chars of session_id (used in VERIFY SIGNAL marker path).
#                 Defaults to "000000000000" if not provided.
shazam_tool_reference() {
  local prefix="${1:-000000000000}"
  local watchdog_dir="${SHAZAM_WATCHDOG_DIR:-/tmp}"
  cat << SUB
--- pi-shazam MCP tools (${SHAZAM_TOOL_COUNT} tools) ---
Available via mcp__pi-shazam__shazam_<name>. Use these for code analysis:

QUERY (read-only):
mcp__pi-shazam__shazam_overview     project structure + deps + git history + hotspots
mcp__pi-shazam__shazam_lookup       unified symbol/file lookup (def, hover, type hierarchy, file detail)
mcp__pi-shazam__shazam_impact       blast radius + call chain tracing (use --symbol for per-symbol trace)
mcp__pi-shazam__shazam_verify       LSP diagnostics + graph analysis after edits
mcp__pi-shazam__shazam_changes      lightweight git change summary with risk level

ACTION (use with care):
mcp__pi-shazam__shazam_format       auto-format (prettier/biome/ruff/eslint/gofmt/rustfmt)
mcp__pi-shazam__shazam_rename_symbol safe rename (MUST run shazam_impact --symbol first)

CORE RULES: mcp__pi-shazam__shazam_overview first -> mcp__pi-shazam__shazam_lookup before use -> mcp__pi-shazam__shazam_impact before multi-file edit -> mcp__pi-shazam__shazam_impact --symbol before mcp__pi-shazam__shazam_rename_symbol -> mcp__pi-shazam__shazam_verify after edit

REMOVED: shazam_find_tests (use Bash find for test discovery), shazam_safe_delete (use Bash rm directly after manual ref-check via lookup).

VERIFY SIGNAL: after running mcp__pi-shazam__shazam_verify, signal completion to skip future reminders:
  mkdir -p ${watchdog_dir} && echo done > ${watchdog_dir}/verified_${prefix}
SUB
}

# shazam_tool_fallback <tool_name> <error_msg>
# Output tool-specific fallback guidance when a shazam MCP tool fails.
# tool_name: full MCP name (mcp__pi-shazam__shazam_<name>) or short name (shazam_<name>).
# error_msg: truncated to 100 chars in default fallback.
shazam_tool_fallback() {
  local shazam_tool="$1"
  local error_msg="${2:-unknown error}"

  # Strip mcp__pi-shazam__ prefix if present
  shazam_tool="${shazam_tool#mcp__pi-shazam__}"

  case "$shazam_tool" in
    shazam_overview)
      echo "[mcp-health] ${shazam_tool} failed. Fallback: use 'find . -type f -name \"*.ts\" | head -30' + 'cat package.json' + 'git log --oneline -10' to understand the project."
      ;;
    shazam_lookup)
      echo "[mcp-health] ${shazam_tool} failed. Fallback: read the file directly and inspect the symbol definition manually."
      ;;
    shazam_verify)
      echo "[mcp-health] ${shazam_tool} failed. Fallback: run project typecheck/lint directly (e.g., 'npx tsc --noEmit', 'npx eslint .', 'ruff check .')."
      ;;
    shazam_format)
      echo "[mcp-health] ${shazam_tool} failed. Fallback: run formatters directly (e.g., 'npx prettier --write <file>', 'ruff format <file>')."
      ;;
    shazam_impact)
      echo "[mcp-health] ${shazam_tool} failed. Fallback: use 'grep -rn \"<symbol_name>\" --include=\"*.ts\"' to find callers and references."
      ;;
    shazam_changes)
      echo "[mcp-health] ${shazam_tool} failed. Fallback: use 'git diff --stat' + 'git log --oneline -5' to see recent changes."
      ;;
    shazam_rename_symbol)
      echo "[mcp-health] ${shazam_tool} failed. This is a write operation — do NOT proceed manually. Wait for MCP to recover and retry."
      ;;
    *)
      echo "[mcp-health] ${shazam_tool} failed (${error_msg:0:100}). Retry once, or use built-in tools as fallback."
      ;;
  esac
}

# shazam_log_failure <tool_name> <error_msg>
# Write failure to the MCP health log. Auto-truncates log if over 1000 lines.
shazam_log_failure() {
  local tool_name="$1"
  local error_msg="${2:-unknown error}"
  local log_dir="${SHAZAM_LOG_DIR:-/tmp}"
  mkdir -p "$log_dir"
  echo "[$(date -Iseconds)] MCP_FAIL: ${tool_name} error=${error_msg:0:200}" >> "${log_dir}/mcp-health.log"

  if [[ -f "${log_dir}/mcp-health.log" ]]; then
    local lines
    lines=$(wc -l < "${log_dir}/mcp-health.log" 2>/dev/null || echo 0)
    if [[ "$lines" -gt 1000 ]]; then
      tail -n 500 "${log_dir}/mcp-health.log" > "${log_dir}/mcp-health.log.tmp"
      mv "${log_dir}/mcp-health.log.tmp" "${log_dir}/mcp-health.log"
    fi
  fi
}

# shazam_mark_unavailable <tool_name> <error_msg>
# Signal that shazam MCP is unavailable so the impact gate can bypass.
# This prevents pre-edit-impact-guard.sh from permanently locking out all edits
# when MCP is down.
shazam_mark_unavailable() {
  local tool_name="$1"
  local error_msg="${2:-}"
  local watchdog_dir="${SHAZAM_WATCHDOG_DIR:-/tmp}"
  mkdir -p "$watchdog_dir"
  echo "$(date -Iseconds) ${tool_name} ${error_msg:0:200}" > "${watchdog_dir}/shazam_unavailable"
}

# shazam_is_unavailable
# Returns 0 (true) if the shazam_unavailable degrade marker exists.
# Use in pre-edit-impact-guard.sh to bypass the impact gate when MCP is down.
shazam_is_unavailable() {
  local watchdog_dir="${SHAZAM_WATCHDOG_DIR:-/tmp}"
  [[ -f "${watchdog_dir}/shazam_unavailable" ]]
}
