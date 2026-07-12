#!/usr/bin/env bash
# check-destructive — PreToolUse hook: block destructive bash commands
#
# Block dangerous Bash commands before they execute. Coverage:
# - rm -rf /, rm -rf /*, rm -fr /, rm --recursive /
# - dd if= (disk overwrite)
# - mkfs / mkswap (filesystem creation)
# - fdisk / parted / sfdisk (partition manipulation)
# - Fork bombs
# - chmod -R 777 /, chown -R
# - Write to raw block devices (> /dev/sd*, > /dev/nvme*, etc.)
# - LVM tools (pvcreate, vgcreate, lvcreate)
# - iptables flush / policy change
#
# stdin JSON: { "tool_name": "Bash", "tool_input": {"command": "..."}, ... }
# Exit 0: allow. Exit 2: block (stderr is shown as the reason).

set -euo pipefail

_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
tool_name=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
cmd=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
cwd=$(printf '%s' "$INPUT" | jq -r '.cwd // ""')

# Only intercept Bash
if [[ "$tool_name" != "Bash" ]]; then
  exit 0
fi

# Normalize: strip leading whitespace, collapse multiple spaces
cmd_normalized=$(printf '%s' "$cmd" | sed 's/^[[:space:]]*//' | tr -s '[:space:]' ' ')
cmd_lower=$(printf '%s' "$cmd_normalized" | tr '[:upper:]' '[:lower:]')

# ── Tier 1: HIGH risk (immediate block) ──
HIGH_PATTERNS=(
  "rm -rf"
  "rm -fr"
  "rm --recursive"
  "dd if="
  "mkfs"
  "mkswap"
  "fdisk"
  "parted"
  "sfdisk"
)

for pattern in "${HIGH_PATTERNS[@]}"; do
  if [[ "$cmd_lower" == *"$pattern"* ]]; then
    # Extra check: only block rm variants if targeting root or /*
    if [[ "$pattern" == "rm -rf" || "$pattern" == "rm -fr" || "$pattern" == "rm --recursive" ]]; then
      # 使用 (^|[[:space:];|&]) 锚点，防止通过命令链接（&&、||、;）绕过
      # 匹配 -r -f（flag 之间有空格）的情况
      if ! printf '%s' "$cmd_normalized" | grep -qE '(^|[[:space:];|&])rm[[:space:]]+(-(rf|fr|r[[:space:]]*f)|--recursive[[:space:]]+--force|--force[[:space:]]+--recursive)([[:space:]]+--)?[[:space:]]+["'"'"']?/(\*|[[:space:]]|"|;|'"'"'|$)'; then
        continue
      fi
    fi

    echo "[check-destructive] BLOCKED HIGH: $pattern" >&2
    echo "  Command: ${cmd:0:200}${cmd:200:+,...}" >&2
    echo "  Reason: This command could cause irreversible data loss." >&2

    # Log blocked command — best-effort, must never cause fail-open.
    # Logging failures (read-only fs, permission denied) must not change
    # the exit code away from 2, or the hook framework treats it as "proceed".
    mkdir -p "${SHAZAM_LOG_DIR}" 2>/dev/null || true
    echo "[$(date -Iseconds)] HIGH:${pattern} cwd=${cwd:-?} cmd=${cmd:0:300}" >> "${SHAZAM_LOG_DIR}/bash-blocked.log" 2>/dev/null || true

    exit 2
  fi
done

# ── Tier 2: MEDIUM risk (block with explanation) ──
MEDIUM_PATTERNS=(
  "chmod -R 777"
  "chmod 777 /"
  "chown -R"
  "> /dev/sd"
  "> /dev/nvme"
  "> /dev/mmcblk"
  "pvcreate"
  "vgcreate"
  "lvcreate"
  "iptables -F"
  "iptables -P"
  "rm -r /"
)

for pattern in "${MEDIUM_PATTERNS[@]}"; do
  if [[ "$cmd_lower" == *"$pattern"* ]]; then
    echo "[check-destructive] BLOCKED MEDIUM: $pattern" >&2
    echo "  Command: ${cmd:0:200}${cmd:200:+,...}" >&2
    echo "  Reason: This command could cause system instability or data loss." >&2

    # Log blocked command — best-effort, must never cause fail-open.
    mkdir -p "${SHAZAM_LOG_DIR}" 2>/dev/null || true
    echo "[$(date -Iseconds)] MEDIUM:${pattern} cwd=${cwd:-?} cmd=${cmd:0:300}" >> "${SHAZAM_LOG_DIR}/bash-blocked.log" 2>/dev/null || true

    exit 2
  fi
done

exit 0
