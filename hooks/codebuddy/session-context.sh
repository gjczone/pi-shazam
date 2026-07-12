#!/usr/bin/env bash
# session-context — CodeBuddy UserPromptSubmit hook: 一次性会话上下文注入
#
# 在每个会话的第一条用户消息时，做两件事：
#   1. 清理 7 天前的旧 marker（避免 watchdog 目录堆积）
#   2. 注入系统级能力提示（避免模型尝试错误用法）
#   3. 留一个 marker 文件标记本会话已初始化，后续提示词不再重复注入
#
# 注意（CodeBuddy 与 Kimi Code 的差异）：
#   原 Kimi Code 版本在此处做了 MCP 预热（后台 npx 拉 pi-shazam 包），
#   但 CodeBuddy 已通过 ~/.codebuddy/.mcp.json 常驻了 pi-shazam-mcp 进程，
#   预热完全多余；且 pi-shazam MCP 当前存在内存泄漏问题（issue 在修），
#   额外 spawn 的预热进程会叠加泄漏面。因此**已移除预热逻辑**，仅保留
#   上下文注入与 marker 清理。
#
# stdin: { "hook_event_name":"UserPromptSubmit", "session_id":"...", "cwd":"..." }
# 退出 0：放行；stdout 内容注入上下文。

set -eu
_SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"
if [[ ! -f "$_SHAZAM_LIB" ]]; then
  _SHAZAM_LIB="$(dirname "${BASH_SOURCE[0]}")/../lib/shazam-common.sh"
fi
source "$_SHAZAM_LIB"

INPUT=$(cat)
hook_event=$(echo "$INPUT" | jq -r '.hook_event_name // ""')
session_id=$(echo "$INPUT" | jq -r '.session_id // ""')
cwd=$(echo "$INPUT" | jq -r '.cwd // ""')
CWD=${cwd:-$(pwd 2>/dev/null || echo "$HOME")}

# 只处理 UserPromptSubmit
[[ "$hook_event" == "UserPromptSubmit" ]] || exit 0

session_prefix="${session_id:0:12}"
init_marker="${WATCHDOG_DIR}/init_${session_prefix}"

# ── 清理 7 天前的旧 marker（每次会话首次 prompt 时跑一次，等价于 SessionStart 清理）──
# 严格只清理已知 marker 模式，绝不误删其它文件：
#   init_* / edits_* / verified_* / pending_impact_*
# 显式排除当前 session 的 marker（防止时间跳变导致 8 天前的当前 marker 被误删）
if [[ -d "${SHAZAM_WATCHDOG_DIR}" ]]; then
  cleaned=$(find "${SHAZAM_WATCHDOG_DIR}" -maxdepth 1 -type f \
    \( -name "init_*" -o -name "edits_*" \
       -o -name "verified_*" -o -name "pending_impact_*" \) \
    ! -name "*_${session_prefix}" \
    -mtime +7 -print -delete 2>/dev/null | wc -l || echo 0)
  if [[ "$cleaned" -gt 0 ]]; then
    echo "[watchdog] cleaned ${cleaned} marker(s) older than 7 days" >&2
  fi
fi

# 已经注入过本会话，直接放行（fast path）
if [[ -f "$init_marker" ]]; then
  exit 0
fi

# 先建 marker，再输出内容，避免并发 prompt 触发双重注入
mkdir -p "${SHAZAM_WATCHDOG_DIR}"
touch "$init_marker"

# =============================================================================
# 系统能力提示（一次）
# =============================================================================
cat << 'CAPS'
【系统能力提示】
- pi-shazam MCP 已由 CodeBuddy 常驻（~/.codebuddy/.mcp.json），无需手动启动；项目内分析优先用 mcp__pi-shazam__shazam_* 工具
- WebSearch / WebFetch 可用，但仅推荐用于外部 API 文档查询
- Bash 工具可执行任意 shell，但带 hook 安全检查（参考 ~/.codebuddy/hooks/）
- 文件读写工具（Edit/Write）会触发 PostToolUse 审计
CAPS

exit 0
