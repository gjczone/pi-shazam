#!/usr/bin/env bash
# check-mcp-parity.sh — Static heuristic checks for MCP-Pi tool parity.
#
# Issue #616 root cause: Pi tool handler changes were not mirrored in
# MCP handlers, leading to 8 behavioral differences. Since #618
# refactored dispatch logic into tools/_dispatchers.ts, both Pi and MCP
# call the same dispatchers. This script verifies that pattern.
#
# Design:
#   - grep + regex heuristic checks (no AST parsing)
#   - Checks both mcp/tools.ts and tools/_dispatchers.ts
#   - Fails with human-readable suggestions when a check fails
#   - Runs as a warning (non-blocking) in CI
#   - References #616 and #618

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

check() {
  local label="$1"
  local cmd="$2"
  local hint="$3"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "  [PASS] $label"
    PASS=$((PASS + 1))
  else
    echo "  [WARN] $label"
    echo "         Hint: $hint"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> MCP-Pi Parity Check"
echo ""

# 1. Shared dispatcher exists and is imported by both Pi and MCP
echo "--- Shared dispatcher module ---"
check \
  "tools/_dispatchers.ts exists" \
  "test -f '$ROOT/tools/_dispatchers.ts'" \
  "The shared dispatcher module must exist at tools/_dispatchers.ts (see #618)."

check \
  "MCP imports dispatchers" \
  "grep -q 'from.*_dispatchers' '$ROOT/mcp/tools.ts'" \
  "mcp/tools.ts must import from tools/_dispatchers.js."

check \
  "Pi tools import dispatchers" \
  "grep -q 'from.*_dispatchers' '$ROOT/tools/overview.ts' && grep -q 'from.*_dispatchers' '$ROOT/tools/lookup.ts'" \
  "At least overview.ts and lookup.ts must import from _dispatchers.js."

# 2. nameIndex guard in dispatcher (was: in mcp/tools.ts)
echo ""
echo "--- shazam_lookup: nameIndex guard ---"
check \
  "dispatchLookup has nameIndex guard before validatePathInProject" \
  "grep -q 'nameIndex.*validatePathInProject\|validatePathInProject.*nameIndex' '$ROOT/tools/_dispatchers.ts'" \
  "The dispatcher must check nameIndex before validatePathInProject (see #497, #616)."

# 3. resetCache and capVerifyDiagnostics in dispatcher (was: in mcp/tools.ts)
echo ""
echo "--- shazam_verify: resetCache and capVerifyDiagnostics ---"
check \
  "dispatchVerify does NOT call resetCache (#626)" \
  "! grep -qE 'await import.*scanner.*resetCache|resetCache\\(\\)' '$ROOT/tools/_dispatchers.ts'" \
  "Issue #626: dispatchVerify must NOT call resetCache() before verify. The previous behavior forced a fresh scan that briefly held two RepoGraphs in memory. scanProject's mtime-based incremental update handles cache freshness without resetCache()."

check \
  "dispatchVerify calls capVerifyDiagnostics" \
  "grep -q 'capVerifyDiagnostics' '$ROOT/tools/_dispatchers.ts'" \
  "The verify dispatcher must call capVerifyDiagnostics for JSON truncation."

# 4. symbol/files mode inference (#629 replaced the strict mutual-exclusion
#    error with an inferImpactMode helper that picks the mode from input
#    shape). We assert the new contract instead of the old one.
echo ""
echo "--- shazam_impact: symbol/files mode inference ---"
check \
  "dispatchImpact uses inferImpactMode" \
  "grep -q 'inferImpactMode' '$ROOT/tools/_dispatchers.ts'" \
  "The impact dispatcher must call inferImpactMode to pick symbol vs files mode."

# 5. Tool registration consistency
echo ""
echo "--- Tool registration ---"
check \
  "MCP registerMcpTool covers all 7 tools" \
  "test \$(grep -c 'registerMcpTool' '$ROOT/mcp/tools.ts') -ge 7" \
  "mcp/tools.ts must call registerMcpTool for each of the 7 tools."

check \
  "MCP tools import getToolDefinition" \
  "grep -q 'import.*getToolDefinition' '$ROOT/mcp/tools.ts'" \
  "mcp/tools.ts must import getToolDefinition from tools/definitions.js."

# 6. existsSync check in lookup dispatch (was: #598 fix)
echo ""
echo "--- shazam_lookup: file existence check ---"
check \
  "dispatchLookup has existsSync check" \
  "grep -q 'existsSync' '$ROOT/tools/_dispatchers.ts'" \
  "The lookup dispatcher must include existsSync for file-path verification (see #598)."

# 7. Tool name parity: every registerMcpTool name must equal a name in
#    tools/definitions.ts (the single source of truth). A drift here means
#    the MCP client sees a different tool name than Pi, or vice versa.
echo ""
echo "--- Tool name parity (MCP name set == definitions name set) ---"
check_tool_names() {
  local defs="$ROOT/tools/definitions.ts"
  local mcp="$ROOT/mcp/tools.ts"
  # names declared in the shared definitions (source of truth)
  local def_names
  def_names=$(grep -oE 'name:\s*"[^"]+"' "$defs" | sed -E 's/name:\s*"([^"]+)"/\1/' | sort -u)
  # names actually registered with the MCP server
  local mcp_names
  mcp_names=$(grep -oE 'registerMcpTool\([^,]+,\s*"[^"]+"' "$mcp" | grep -oE '"[^"]+"' | tr -d '"' | sort -u)
  local only_def only_mcp
  only_def=$(comm -23 <(echo "$def_names") <(echo "$mcp_names"))
  only_mcp=$(comm -13 <(echo "$def_names") <(echo "$mcp_names"))
  if [ -z "$only_def" ] && [ -z "$only_mcp" ]; then
    echo "  [PASS] MCP tool names match definitions.ts exactly"
    PASS=$((PASS + 1))
    return 0
  fi
  echo "  [WARN] MCP tool names diverge from definitions.ts"
  [ -n "$only_def" ] && echo "         In definitions.ts but NOT registered in MCP: $only_def"
  [ -n "$only_mcp" ] && echo "         Registered in MCP but NOT in definitions.ts: $only_mcp"
  echo "         Hint: the MCP name set must equal the definitions.ts name set (single source of truth)."
  FAIL=$((FAIL + 1))
}
check_tool_names

echo ""
echo "==> Parity Check Results: $PASS passed, $FAIL warnings"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "Some parity checks produced warnings. Review the hints above."
  echo "These are non-blocking but should be addressed to prevent MCP-Pi drift."
fi
