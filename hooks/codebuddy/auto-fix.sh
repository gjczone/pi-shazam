#!/usr/bin/env bash
# auto-fix — PostToolUse hook: auto-format files after Edit/Write
#
# Detects available formatters (same logic as mcp__pi-shazam__shazam_format) and runs them
# on the edited file. Fast, targeted — only formats the changed file.
#
# Supported formatters:
# - prettier (JS/TS/JSON/MD/CSS)
# - eslint --fix (JS/TS)
# - ruff format (Python)
# - gofmt (Go)
# - rustfmt (Rust)
# - biome (JS/TS/JSON)
#
# stdin JSON: { "tool_name": "Edit|Write", "tool_input": {"file_path": "..."}, ... }
# Exit 0: allow. stdout shown to LLM as context.

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Only trigger for file writes
if [[ "$tool_name" != "Edit" && "$tool_name" != "Write" ]]; then
  exit 0
fi

file_path=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
[[ -z "$file_path" ]] && exit 0

# Resolve to absolute path if relative
if [[ "$file_path" != /* ]]; then
  cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
  file_path="${cwd:-$(pwd)}/${file_path}"
fi

# Check file exists
[[ -f "$file_path" ]] || exit 0

# Get extension
ext="${file_path##*.}"
filename=$(basename "$file_path")

# Project root (cwd from hook context)
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
PROJECT_ROOT="${cwd:-$(pwd)}"

# =========================================================================
# Detect and run formatters (same logic as mcp__pi-shazam__shazam_format tools/format.ts)
# =========================================================================

formatted=false
errors=""

# --- prettier (JS/TS/JSON/MD/CSS/YAML) ---
if echo "$ext" | grep -qE '^(ts|tsx|js|jsx|json|md|css|scss|html|yaml|yml|vue|svelte)$'; then
  has_prettier=false
  [[ -f "${PROJECT_ROOT}/.prettierrc" ]] && has_prettier=true
  [[ -f "${PROJECT_ROOT}/.prettierrc.json" ]] && has_prettier=true
  [[ -f "${PROJECT_ROOT}/.prettierrc.js" ]] && has_prettier=true
  [[ -f "${PROJECT_ROOT}/prettier.config.js" ]] && has_prettier=true
  [[ -f "${PROJECT_ROOT}/prettier.config.mjs" ]] && has_prettier=true
  grep -q '"prettier"' "${PROJECT_ROOT}/package.json" 2>/dev/null && has_prettier=true

  if [[ "$has_prettier" == "true" ]]; then
    if [[ -x "${PROJECT_ROOT}/node_modules/.bin/prettier" ]]; then
      "${PROJECT_ROOT}/node_modules/.bin/prettier" --write "$file_path" 2>/dev/null && formatted=true || errors="${errors}prettier failed; "
    elif npx --yes prettier --write "$file_path" 2>/dev/null; then
      formatted=true
    else
      errors="${errors}prettier failed; "
    fi
  fi
fi

# --- eslint --fix (JS/TS) ---
if echo "$ext" | grep -qE '^(ts|tsx|js|jsx)$'; then
  has_eslint=false
  [[ -f "${PROJECT_ROOT}/eslint.config.js" ]] && has_eslint=true
  [[ -f "${PROJECT_ROOT}/eslint.config.mjs" ]] && has_eslint=true
  [[ -f "${PROJECT_ROOT}/.eslintrc.js" ]] && has_eslint=true
  [[ -f "${PROJECT_ROOT}/.eslintrc.json" ]] && has_eslint=true
  [[ -f "${PROJECT_ROOT}/.eslintrc.cjs" ]] && has_eslint=true

  if [[ "$has_eslint" == "true" ]]; then
    if [[ -x "${PROJECT_ROOT}/node_modules/.bin/eslint" ]]; then
      "${PROJECT_ROOT}/node_modules/.bin/eslint" --fix "$file_path" 2>/dev/null && formatted=true || errors="${errors}eslint --fix failed; "
    elif npx --yes eslint --fix "$file_path" 2>/dev/null; then
      formatted=true
    else
      errors="${errors}eslint --fix failed; "
    fi
  fi
fi

# --- ruff format (Python) ---
if [[ "$ext" == "py" ]]; then
  has_ruff=false
  [[ -f "${PROJECT_ROOT}/ruff.toml" ]] && has_ruff=true
  [[ -f "${PROJECT_ROOT}/pyproject.toml" ]] && grep -q '\[tool.ruff\]' "${PROJECT_ROOT}/pyproject.toml" 2>/dev/null && has_ruff=true

  if [[ "$has_ruff" == "true" ]]; then
    if ruff format "$file_path" 2>/dev/null; then
      formatted=true
    else
      errors="${errors}ruff format failed; "
    fi
  fi
fi

# --- gofmt (Go) ---
if [[ "$ext" == "go" ]]; then
  if command -v gofmt &>/dev/null; then
    if gofmt -w "$file_path" 2>/dev/null; then
      formatted=true
    else
      errors="${errors}gofmt failed; "
    fi
  fi
fi

# --- rustfmt (Rust) ---
if [[ "$ext" == "rs" ]]; then
  if command -v rustfmt &>/dev/null; then
    if rustfmt "$file_path" 2>/dev/null; then
      formatted=true
    else
      errors="${errors}rustfmt failed; "
    fi
  fi
fi

# --- biome (JS/TS/JSON) ---
if echo "$ext" | grep -qE '^(ts|tsx|js|jsx|json)$'; then
  if [[ -f "${PROJECT_ROOT}/biome.json" ]] || [[ -f "${PROJECT_ROOT}/biome.jsonc" ]]; then
    if [[ -x "${PROJECT_ROOT}/node_modules/.bin/biome" ]]; then
      "${PROJECT_ROOT}/node_modules/.bin/biome" check --write "$file_path" 2>/dev/null && formatted=true || errors="${errors}biome check failed; "
    elif npx --yes @biomejs/biome check --write "$file_path" 2>/dev/null; then
      formatted=true
    else
      errors="${errors}@biomejs/biome check failed; "
    fi
  fi
fi

# Output: success shows what ran, failure shows errors
if [[ -n "$errors" ]]; then
  echo "[auto-fix] formatted ${file_path} but had errors: ${errors}"
elif [[ "$formatted" == "true" ]]; then
  echo "[auto-fix] formatted ${file_path}"
fi

exit 0
