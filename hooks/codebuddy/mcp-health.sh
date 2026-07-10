#!/usr/bin/env bash
# mcp-health — PostToolUse hook: detect MCP failures, suggest fallback
#
# When an mcp__pi-shazam__* tool call fails (timeout, process crash, connection
# error), this hook provides actionable fallback guidance to the LLM instead
# of leaving it stranded with a raw error message.
#
# Fallback text and degrade logic are sourced from lib/shazam-common.sh.
#
# stdin JSON: { "hook_event_name": "PostToolUse", "tool_name": "...", "tool_output": "...", "error": {...} }
# Exit 0: allow. stdout shown to LLM as context.
#
# NOTE: CodeBuddy has no PostToolUseFailure event — both success and failure
# arrive as PostToolUse. We detect MCP failures via error.message or typical
# error markers in tool_output, and stay silent on success.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only handle MCP tool calls in PostToolUse (no PostToolUseFailure event)
if [[ "$hook_event" != "PostToolUse" ]]; then
  exit 0
fi
if [[ "$tool_name" != mcp__pi-shazam__* ]]; then
  exit 0
fi

# Detect failure: structured error.message, or error markers in tool_output
error_msg=$(echo "$INPUT" | jq -r '.error.message // ""')
tool_output=$(echo "$INPUT" | jq -r '.tool_output // ""')
if [[ -z "$error_msg" ]]; then
  if echo "$tool_output" | grep -qiE '(^|\b)(error|failed|fatal|traceback|exception|timed out|timeout|connection|refused|econnrefused|enotfound|crash):'; then
    error_msg="${tool_output:0:200}"
  fi
fi

# Success (no error detected) -> stay silent
if [[ -z "$error_msg" ]]; then
  exit 0
fi

error_msg="${error_msg:-unknown error}"

# Log failure and mark shazam unavailable (degrade signal for impact gate)
shazam_log_failure "$tool_name" "$error_msg"
shazam_mark_unavailable "$tool_name" "$error_msg"

# Provide tool-specific fallback guidance
shazam_tool_fallback "$tool_name" "$error_msg"

exit 0
