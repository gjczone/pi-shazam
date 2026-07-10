#!/usr/bin/env bash
# shazam-guide — PreToolUse + PostToolUse hook: context-aware shazam tool suggestions
#
# Suggests pi-shazam MCP tools as alternatives to common Bash commands
# (e.g., grep → shazam_lookup, find/ls → shazam_overview).
#
# Tool names and paths are sourced from lib/shazam-common.sh.
#
# stdin JSON: { "hook_event_name": "PreToolUse|PostToolUse", "tool_name": "Edit|Write|Bash", "tool_input": {...}, "tool_output": "..." }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

# =========================================================================
# PostToolUse: after write/edit operations — suggest verification
# =========================================================================
if [[ "$hook_event" == "PostToolUse" ]]; then
  if [[ "$tool_name" == "Edit" || "$tool_name" == "Write" ]]; then
    tool_output=$(echo "$INPUT" | jq -r '.tool_output // ""')
    path_count=0
    if [[ -n "$tool_output" ]]; then
      path_count=$(echo "$tool_output" | grep -oE '[a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5}' | wc -l 2>/dev/null) || path_count=0
    fi
    if [[ "$path_count" -ge 3 ]]; then
      echo "mcp__pi-shazam__shazam_impact checks blast radius across all affected files — consider running it before continuing"
    else
      echo "run mcp__pi-shazam__shazam_verify to check for errors after this edit"
    fi
    exit 0
  fi
  exit 0
fi

# =========================================================================
# PreToolUse: before tool execution — suggest better alternatives
# =========================================================================
if [[ "$hook_event" != "PreToolUse" ]]; then
  exit 0
fi

# --- Bash commands ---
if [[ "$tool_name" == "Bash" ]]; then
  cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  [[ -z "$cmd" ]] && exit 0

  if echo "$cmd" | grep -qE '(^|[[:space:]])(grep|rg)[[:space:]].*\.(ts|js|py|rs|go|java|tsx|jsx|vue|svelte|dart)'; then
    echo "mcp__pi-shazam__shazam_lookup finds symbol definitions, type signatures, and hierarchy — faster than grep for code exploration"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(^|[[:space:]])(cat|head|tail|less)[[:space:]].*\.(ts|js|py|rs|go|java|tsx|jsx|dart)'; then
    echo "mcp__pi-shazam__shazam_lookup shows all symbols, signatures, and dependencies — more efficient than reading raw source"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(^|[[:space:]])(ls|tree|find[[:space:]]+\.)[[:space:]]'; then
    echo "mcp__pi-shazam__shazam_overview gives full project structure, top files, dependencies, and recent commits in one call"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(^|[[:space:]])git[[:space:]]+(status|log|diff|show)'; then
    echo "mcp__pi-shazam__shazam_overview already includes recent commits and git status; mcp__pi-shazam__shazam_changes gives lightweight risk-level summary"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(npm[[:space:]]+(ls|list)|pip3?[[:space:]]+(list|show|freeze)|uv[[:space:]]+(pip|tree)|cargo[[:space:]]+tree|pnpm[[:space:]]+(ls|list))'; then
    echo "mcp__pi-shazam__shazam_overview already lists key dependencies with versions"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(npm[[:space:]]+(test|tst)|pnpm[[:space:]]+test|yarn[[:space:]]+test|pytest|cargo[[:space:]]+test|vitest|jest)'; then
    echo "shazam_find_tests is not available — use 'find . -name \"*.test.*\" -o -name \"*_test.*\"' to locate test files, or run tests directly"
    exit 0
  fi

  if echo "$cmd" | grep -qiE '(class|interface|extends|implements|abstract|inheritance)'; then
    echo "mcp__pi-shazam__shazam_lookup shows full class inheritance chain and interface implementations (auto-detects type hierarchy)"
    exit 0
  fi

  if echo "$cmd" | grep -qiE '(rename|refactor|extract|change[[:space:]]+signature)'; then
    echo "mcp__pi-shazam__shazam_impact --symbol traces all callers before changing a function signature; mcp__pi-shazam__shazam_rename_symbol safely renames with reference verification — use them first"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(^|[[:space:]])rm[[:space:]].*\.(ts|js|py|rs|go|dart)'; then
    echo "shazam_safe_delete is not available — before rm, use mcp__pi-shazam__shazam_lookup to confirm zero external refs to this file"
    exit 0
  fi

  if echo "$cmd" | grep -qiE '(grep|rg|cat|head).*(type|interface|signature|typedef)'; then
    echo "mcp__pi-shazam__shazam_lookup shows full type signature and JSDoc docs — use it instead of inspecting source manually"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(eslint|prettier|ruff\s+(check|format)|cargo\s+(fmt|clippy)|gofmt|golint)'; then
    echo "mcp__pi-shazam__shazam_format runs nearest-wins formatters (prettier/eslint/biome/ruff/gofmt/rustfmt) with one call"
    exit 0
  fi

  if echo "$cmd" | grep -qiE '(slow|bottleneck|optimize|performance|hot|critical|frequent|complexity)'; then
    echo "mcp__pi-shazam__shazam_overview ranks files by blast radius (hotspots) — focus optimization on high-risk files first"
    exit 0
  fi

  if echo "$cmd" | grep -qE '(sed|awk|tee|cat.*EOF|>>)'; then
    echo "mcp__pi-shazam__shazam_impact checks blast radius before editing; mcp__pi-shazam__shazam_verify checks errors after"
    exit 0
  fi

  exit 0
fi

# --- Edit/Write → impact + verify ---
if [[ "$tool_name" == "Edit" || "$tool_name" == "Write" ]]; then
  session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
  edit_count=0
  if [[ -n "$session_id" ]]; then
    edit_file="${SHAZAM_WATCHDOG_DIR}/edits_${session_id:0:12}"
    [[ -f "$edit_file" ]] && edit_count=$(cat "$edit_file" 2>/dev/null || echo 0)
  fi
  if [[ "$edit_count" -ge 2 ]]; then
    echo "mcp__pi-shazam__shazam_impact — this is edit #$((edit_count + 1)) this session, use impact to check multi-file blast radius; then mcp__pi-shazam__shazam_verify after editing"
  else
    echo "mcp__pi-shazam__shazam_impact checks blast radius before editing; mcp__pi-shazam__shazam_verify checks errors after"
  fi
  exit 0
fi

exit 0
