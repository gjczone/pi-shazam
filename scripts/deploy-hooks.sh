#!/usr/bin/env bash
# deploy-hooks — deploy pi-shazam hooks from project source to ~/.codebuddy/hooks/ and ~/.kimi-code/hooks/
#
# This script copies hooks/lib/shazam-common.sh and platform-specific adapter .sh
# scripts from the pi-shazam project repo to the CodeBuddy and Kimi Code hook
# directories under $HOME. It does NOT modify settings.json or config.toml.
#
# Usage:
#   bash scripts/deploy-hooks.sh          # dry-run (show diffs, no writes)
#   bash scripts/deploy-hooks.sh --apply  # actually deploy

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CB="$HOME/.codebuddy/hooks"
KIMI="$HOME/.kimi-code/hooks"
DRY_RUN=1

[[ "${1:-}" == "--apply" ]] && DRY_RUN=0

# ── Helpers ──

RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0

check() {
  local label="$1"; local cmd="$2"; local hint="${3:-}"
  if eval "$cmd" &>/dev/null; then
    printf "${GREEN}[PASS]${NC} %s\n" "$label"
    ((PASS++)) || true
  else
    printf "${RED}[FAIL]${NC} %s\n" "$label"
    [[ -n "$hint" ]] && printf "  ${YELLOW}->${NC} %s\n" "$hint"
    ((FAIL++)) || true
  fi
}

warn() {
  printf "${YELLOW}[WARN]${NC} %s\n" "$1"
  ((WARN++)) || true
}

deploy_file() {
  local src="$1"; local dst="$2"
  if [[ ! -f "$src" ]]; then
    printf "${RED}[FAIL]${NC} source missing: %s\n" "$src"
    ((FAIL++)) || true
    return
  fi
  if (( DRY_RUN )); then
    if [[ -f "$dst" ]]; then
      if ! diff -q "$src" "$dst" &>/dev/null; then
        printf "  ${YELLOW}[DIFF]${NC} %s\n" "$dst"
        diff -u "$dst" "$src" || true
      fi
    else
      printf "  ${GREEN}[NEW]${NC}  %s\n" "$dst"
    fi
  else
    cp "$src" "$dst"
    chmod +x "$dst"
    printf "  ${GREEN}[COPY]${NC} %s\n" "$dst"
  fi
}

# ── Phase 1: Deploy shared lib ──

echo "=== Shared lib ==="
LIB_SRC="$ROOT/hooks/lib/shazam-common.sh"
deploy_file "$LIB_SRC" "$CB/lib/shazam-common.sh"
deploy_file "$LIB_SRC" "$KIMI/lib/shazam-common.sh"

# ── Phase 2: Deploy CodeBuddy adapter .sh ──

echo "=== CodeBuddy adapters ==="
CB_SRC="$ROOT/hooks/codebuddy"
if [[ -d "$CB_SRC" ]]; then
  for src in "$CB_SRC"/*.sh; do
    [[ -f "$src" ]] || continue
    fname="$(basename "$src")"
    deploy_file "$src" "$CB/$fname"
  done
fi

# ── Phase 3: Deploy Kimi adapter .sh ──

echo "=== Kimi adapters ==="
KIMI_SRC="$ROOT/hooks/kimi"
if [[ -d "$KIMI_SRC" ]]; then
  for src in "$KIMI_SRC"/*.sh; do
    [[ -f "$src" ]] || continue
    fname="$(basename "$src")"
    deploy_file "$src" "$KIMI/$fname"
  done
fi

# ── Syntax check ──

echo "=== Syntax check ==="
	for dir in "$CB" "$KIMI"; do
  for f in "$dir"/*.sh "$dir"/lib/*.sh; do
    [[ -f "$f" ]] || continue
    check "bash -n $(basename "$dir")/$(basename "$f")" \
      "bash -n $f" \
      "fix syntax error in $f"
  done
done

# ── Source-path resolution check ──
# Every deployed hook must be able to resolve shazam-common.sh via its
# layout-resilient resolver (sibling lib/ then ../lib/). A broken source path
# makes the hook fail-open under set -eu (issue #728 / #750), so assert it here.

echo "=== Source-path resolution ==="
for f in "$CB"/*.sh "$KIMI"/*.sh; do
  [[ -f "$f" ]] || continue
  resolved="$(dirname "$f")/lib/shazam-common.sh"
  [[ -f "$resolved" ]] || resolved="$(dirname "$f")/../lib/shazam-common.sh"
  check "lib resolves for $(basename "$f")" \
    "test -f '$resolved'" \
    "source path broken in $f (resolver could not locate shazam-common.sh)"
done

# ── Drift detection ──

echo "=== Drift detection ==="

detect_drift() {
  local src_dir="$1"; local dst_dir="$2"; local label="$3"
  if [[ ! -d "$src_dir" ]]; then
    warn "$label source dir missing: $src_dir"
    return
  fi
  if [[ ! -d "$dst_dir" ]]; then
    warn "$label target dir missing: $dst_dir"
    return
  fi
  # Check for .sh in target not in source (drifted/orphaned)
  for dst_f in "$dst_dir"/*.sh; do
    [[ -f "$dst_f" ]] || continue
    fname="$(basename "$dst_f")"
    if [[ ! -f "$src_dir/$fname" ]]; then
      warn "$label orphan .sh (not in source): $dst_f"
    fi
  done
}

detect_drift "$CB_SRC" "$CB" "CodeBuddy"
detect_drift "$KIMI_SRC" "$KIMI" "Kimi"

# ── Summary ──

echo ""
echo "=== Summary ==="
printf "PASS=${GREEN}%d${NC}  WARN=${YELLOW}%d${NC}  FAIL=${RED}%d${NC}\n" "$PASS" "$WARN" "$FAIL"

if (( DRY_RUN )); then
  echo "DRY-RUN: no files written. Use --apply to deploy."
fi

(( FAIL > 0 )) && exit 1
exit 0
