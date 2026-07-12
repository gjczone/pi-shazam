#!/usr/bin/env bash
# agent-context-guard — PreToolUse hook: require structural context before Agent spawn
#
# Before spawning an Agent/AgentSwarm for non-trivial tasks, this hook checks
# whether the prompt includes file paths / symbol names / structural context.
# If missing for investigation/review/coding tasks, it BLOCKS (exit 2) and
# tells the LLM to provide context via shazam_lookup or shazam_overview first.
#
# Updated for tool consolidation: file_detail/codesearch → lookup.
#
# stdin: { "hook_event_name": "PreToolUse", "tool_name": "Agent|AgentSwarm", "tool_input": {...} }
# Exit 0: allow. Exit 2: block until context is added.

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')
prompt=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null || echo "")

# Skip if prompt is empty (resume-only)
[[ -z "$prompt" ]] && exit 0

# ── Classify task ──
word_count=$(echo "$prompt" | wc -w)

is_investigation=false
is_coding=false
is_review=false

if echo "$prompt" | grep -qiE '(investigat|explore|search|find|locate|understand|check|inspect|read)'; then
  is_investigation=true
fi
if echo "$prompt" | grep -qiE '(implement|write|edit|create|add|modify|change|refactor|extract|fix|bug|patch)'; then
  is_coding=true
fi
if echo "$prompt" | grep -qiE '(review|audit|vulnerabilit|security|integrity|bloat|simplif|adversarial)'; then
  is_review=true
fi

# Skip trivial tasks (< 30 words and not review/coding)
if [[ "$word_count" -lt 30 ]] && ! $is_review && ! $is_coding; then
  exit 0
fi

# ── Check for structural context markers ──
# A prompt should include at least one of:
#   - File paths (src/..., backend/..., /path/to/file.ext)
#   - Symbol names in backticks or quotes
#   - Line numbers
#   - shazam tool call results
has_file_paths=$(echo "$prompt" | grep -cE '(src/|backend/|tests/|\.tsx?|\.rs|\.py|\.go|\b\w+\.\w+\b)' || true)
has_symbols=$(echo "$prompt" | grep -cE '(`[^`]+`|"[^"]+")' || true)
has_line_nums=$(echo "$prompt" | grep -cE '(line |:\d+)' || true)
has_shazam=$(echo "$prompt" | grep -ciE '(shazam_|lookup|overview|impact)' || true)

context_score=$((has_file_paths + has_symbols + has_line_nums + has_shazam * 3))

# ── Decision ──
# Review/audit tasks: suggest context but don't block
if $is_review && [[ "$context_score" -lt 2 ]]; then
  echo "> Agent task is a review/audit — consider providing file paths or symbol names from shazam_lookup for better results."
fi

# Coding tasks > 50 words without context: suggest but don't block (too aggressive)
if $is_coding && [[ "$word_count" -gt 50 ]] && [[ "$context_score" -lt 1 ]]; then
  echo "> Agent task lacks file/symbol context — consider: shazam_lookup on target files, shazam_impact for multi-file changes"
fi

exit 0
