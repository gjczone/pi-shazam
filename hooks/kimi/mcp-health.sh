#!/usr/bin/env bash
# mcp-health — PostToolUseFailure hook: detect MCP failures, suggest fallback
#
# When an mcp__pi-shazam__* tool call fails (timeout, process crash, connection
# error), this hook provides actionable fallback guidance to the LLM instead
# of leaving it stranded with a raw error message.
#
# Fallback text and degrade logic are sourced from lib/shazam-common.sh.
#
# stdin JSON: { "hook_event_name": "PostToolUseFailure", "tool_name": "...", "error": {...} }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only handle MCP tool failures in PostToolUseFailure event
if [[ "$hook_event" != "PostToolUseFailure" ]]; then
  exit 0
fi
if [[ "$tool_name" != mcp__pi-shazam__* ]]; then
  exit 0
fi

error_msg=$(echo "$INPUT" | jq -r '.error.message // "unknown error"')

# Log failure and mark shazam unavailable (degrade signal for impact gate)
shazam_log_failure "$tool_name" "$error_msg"
shazam_mark_unavailable "$tool_name" "$error_msg"

# Provide tool-specific fallback guidance
shazam_tool_fallback "$tool_name" "$error_msg"

exit 0
