#!/usr/bin/env bash
# mcp-audit — PostToolUse hook: log successful MCP (shazam) tool calls
#
# Complements mcp-health.sh (which logs failures). Together they provide
# complete visibility into MCP tool usage from codebuddy:
#   - Success: mcp-audit.sh → mcp-audit.log
#   - Failure: mcp-health.sh → mcp-health.log
#
# This enables analysis of:
#   - Which shazam tools are used most/least
#   - Tool call frequency per session/project
#   - Correlation between tool usage and project outcomes
#   - Whether the LLM follows recommended tool workflows
#
# stdin JSON: { "hook_event_name": "PostToolUse", "tool_name": "...", "session_id": "...", "tool_output": "..." }
# Exit 0: allow. Silent (no stdout).

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
CWD=${cwd:-$(pwd 2>/dev/null || echo "unknown")}

# Only log MCP shazam tool successes
if [[ "$hook_event" != "PostToolUse" ]]; then
  exit 0
fi

if [[ "$tool_name" != mcp__pi-shazam__* ]]; then
  exit 0
fi

# Extract tool name (strip mcp__pi-shazam__ prefix)
shazam_tool="${tool_name#mcp__pi-shazam__}"

# Estimate output size as a proxy for result richness
tool_output=$(echo "$INPUT" | jq -r '.tool_output // ""')
output_len=${#tool_output}

# Log to mcp-audit.log (JSONL for easy parsing)
mkdir -p "${SHAZAM_LOG_DIR}"

ts=$(date -Iseconds)
echo "{\"ts\":\"${ts}\",\"session\":\"${session_id:0:12}\",\"tool\":\"${shazam_tool}\",\"project\":\"${CWD}\",\"outputBytes\":${output_len}}" >> "${LOG_DIR}/mcp-audit.log"

# Log rotation: truncate if over 5000 lines, keep last 2000
if [[ -f "${LOG_DIR}/mcp-audit.log" ]]; then
  lines=$(wc -l < "${LOG_DIR}/mcp-audit.log" 2>/dev/null || echo 0)
  if [[ "$lines" -gt 5000 ]]; then
    tail -n 2000 "${LOG_DIR}/mcp-audit.log" > "${LOG_DIR}/mcp-audit.log.tmp"
    mv "${LOG_DIR}/mcp-audit.log.tmp" "${LOG_DIR}/mcp-audit.log"
  fi
fi

exit 0
