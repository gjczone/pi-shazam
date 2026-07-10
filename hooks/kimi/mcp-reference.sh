#!/usr/bin/env bash
# mcp-reference — SubagentStart hook: inject MCP tool reference
#
# Injects pi-shazam MCP tool reference into subagent context so every
# subagent knows what tools are available and when to use them.
#
# Tool reference text is sourced from lib/shazam-common.sh (shared between
# CodeBuddy and Kimi Code). Update that file when tools change.
#
# stdin (SubagentStart): { "hook_event_name":"SubagentStart", "agent_name":"coder", ... }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
agent_name=$(echo "$INPUT" | jq -r '.agent_name // ""')
matcher_value=$(echo "$INPUT" | jq -r '.matcher_value // "startup"')
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
session_prefix="${session_id:0:12}"

# =============================================================================
# SubagentStart — inject into subagent context
# =============================================================================
if [[ "$hook_event" == "SubagentStart" ]]; then
  shazam_tool_reference "$session_prefix"
  exit 0
fi

exit 0
