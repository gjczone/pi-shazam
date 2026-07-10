#!/usr/bin/env bash
# mcp-reference — SessionStart + PreToolUse(Task) hook: inject MCP tool reference
#
# CodeBuddy has no SubagentStart event. We inject the pi-shazam MCP tool
# reference in two places:
#   1. SessionStart  — into the main session context (once per session)
#   2. PreToolUse(Task) — before spawning a sub-agent (tool_name="Task"),
#      so the sub-agent prompt carries the tool reference
#      (throttled by a per-session marker).
#
# Tool reference text is sourced from lib/shazam-common.sh (shared between
# CodeBuddy and Kimi Code). Update that file when tools change.
#
# stdin (SessionStart): { "hook_event_name":"SessionStart", "matcher_value":"startup|resume", ... }
# stdin (PreToolUse):   { "hook_event_name":"PreToolUse", "tool_name":"Task", ... }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')
agent_name=$(echo "$INPUT" | jq -r '.agent_name // ""')
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
session_prefix="${session_id:0:12}"

mkdir -p "$SHAZAM_WATCHDOG_DIR"

# =============================================================================
# SessionStart — inject into main session context (once)
# =============================================================================
if [[ "$hook_event" == "SessionStart" ]]; then
  shazam_tool_reference "$session_prefix"
  exit 0
fi

# =============================================================================
# PreToolUse(Task) — inject into sub-agent prompt (throttled per session)
# =============================================================================
if [[ "$hook_event" == "PreToolUse" && "$tool_name" == "Task" ]]; then
  agent_ref_marker="${SHAZAM_WATCHDOG_DIR}/agent_ref_${session_prefix}"
  # Only inject once per session to avoid repeated noise
  if [[ -f "$agent_ref_marker" ]]; then
    exit 0
  fi
  touch "$agent_ref_marker"
  shazam_tool_reference "$session_prefix"
  exit 0
fi

exit 0
