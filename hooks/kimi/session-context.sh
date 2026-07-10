#!/usr/bin/env bash
# session-context — Kimi Code UserPromptSubmit hook: 一次性项目上下文注入 + MCP 预热
#
# 在每个会话的第一条用户消息时，做四件事：
#   1. 清理 7 天前的旧 marker（避免 watchdog 目录堆积）
#   2. 注入 WebSearch 等系统级能力提示（避免模型尝试错误用法）
#   3. 预热 MCP 工具（后台拉一次 pi-shazam 包，让首次 MCP 调用零延迟）
#   4. 留一个 marker 文件标记本会话已初始化，后续提示词不再重复注入
#
# 为什么需要预热：npx 首次拉取 pi-shazam 需要 5-15s，会让"第一次 MCP 调用"看起来很慢。
# 提前在后台拉一次，用户的真实交互就感觉不到延迟。
#
# 参考 ~/.trae-cn/hooks/session-context.sh 的设计（结构对齐，路径仅替换 .trae-cn → .kimi-code）：
#   - 用 marker 文件做幂等，每个 session 注入一次
#   - 预热放后台（& + disown），不阻塞当前 prompt
#   - 7 天 marker 清理放首次 prompt 时跑（等价于 SessionStart 清理）
#
# 关于"项目概览注入"的决策：
#   旧实现会 spawn `npx pi-shazam-mcp "$CWD"` 拉一次 overview，但那会真实启动 MCP server，
#   跟 Kimi Code 自己的 MCP 抢端口/临时目录，且每次启动有 5-15s 延迟。
#   改为：仅做包预热，让模型在需要时自己调 mcp__pi-shazam__shazam_overview。
#   SubagentStart hook（mcp-reference.sh）已经注入了工具清单，模型知道有这工具。
#
# stdin: { "hook_event_name":"UserPromptSubmit", "session_id":"...", "cwd":"..." }
# 退出 0：放行；stdout 内容注入上下文。

set -eu
source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"

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
# 为什么放这里而不是单独 cron：
#   1. 一次会话首次 prompt 1 次已够 — 旧会话已死，marker 无意义
#   2. Kimi Code 无 SessionStart 事件，UserPromptSubmit 是最早的稳定 hook
#   3. 避免新增定时任务，零运维成本
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
# 1. 系统能力提示（一次）
# =============================================================================
cat << 'CAPS'
【系统能力提示】
- WebSearch / WebFetch 可用，但仅推荐用于外部 API 文档查询；项目内分析请优先用 mcp__* 工具
- Bash 工具可执行任意 shell，但带 hook 安全检查（参考 ~/.kimi-code/hooks/）
- 文件读写工具（WriteFile/StrReplaceFile）会触发 PostToolUse 审计
CAPS

# =============================================================================
# 2. npx warmup (background, non-blocking) — three-tier fallback
# =============================================================================
# 目标：让首次 mcp__pi-shazam__* 调用零延迟。
#
# 关键命名：包名是 `pi-shazam`，二进制名是 `pi-shazam-mcp`。
#   - npx -p 后面接的是"包名"，不是"二进制名"
#   - 之前误把 -p pi-shazam-mcp 会触发 npm 404
#
# 关键技巧：用 `npx -p <pkg> -c "true"` 触发下载但什么都不执行。
#   - 不要用 `pi-shazam-mcp --version`：MCP 服务把 --version 当成 PROJECT_ROOT 路径
#     找不到文件就 exit 1，反而误判"包不可用"
#   - 不要用 `npx pi-shazam-mcp /tmp`：会真的启动 MCP server，跟 kimi-code 抢端口
#   - `-c "true"` 是 npx 标准的"下载+无副作用"姿势
#
# Tier 1 (fast):  npx -y -p pi-shazam -c "true"           优先用本地缓存
# Tier 2 (fresh): npx -y --prefer-online -p pi-shazam@latest -c "true"
#                                                              仅当 Tier 1 失败才联网拉最新
# Tier 3 (bin):   直接 command -v 探测 — 仅当 npx 不可用但二进制全局装了
#                                                              全局装时无下载需求，标 ready 即可
#
# 全部失败也不影响主流程（& + disown），首次 MCP 调用会自愈。
# 每级加 timeout 防止后台进程无限挂起。
#
# 注意：取消 --prefer-online 作为默认行为。原来的设计是每次会话都查 npm，
# 在缓存已暖的情况下反而变慢。改为：默认用缓存，仅 Tier 1 失败才联网拉最新。
prewarm_mcp() {
  local log="${SHAZAM_LOG_DIR}/mcp-prewarm.log"
  local mode=""

  if command -v npx >/dev/null 2>&1; then
    if timeout 25 npx -y -p pi-shazam -c "true" >/dev/null 2>&1; then
      mode="tier1-cache"
    elif timeout 30 npx -y --prefer-online -p pi-shazam@latest -c "true" >/dev/null 2>&1; then
      mode="tier2-latest"
    else
      mode="tier1+tier2-fail"
    fi
  elif command -v pi-shazam-mcp >/dev/null 2>&1; then
    mode="tier3-binary"
  else
    mode="no-mcp-runtime"
  fi

  echo "[$(date -Iseconds)] prewarm mode=${mode}" >> "$log" 2>/dev/null || true
}

(prewarm_mcp) &
disown || true

exit 0
