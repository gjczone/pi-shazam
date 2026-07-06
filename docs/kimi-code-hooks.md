---
name: kimi-code-hooks
description: "How to write Kimi Code hooks (shell scripts triggered by lifecycle events). Covers config.toml [[hooks]] setup, stdin JSON protocol, exit codes, all events. Use when adding hooks to Kimi Code's config.toml."
---

# Kimi Code Hooks — Shell Script Lifecycle Handlers

> 来源：官方文档 https://moonshotai.github.io/kimi-code/en/customization/hooks.html

Kimi Code hooks 是配置在 `~/.kimi-code/config.toml` 中的 Shell 脚本，由 15 种生命周期事件触发。触发时 CLI 将事件详情打包成 JSON 通过 stdin 传给脚本。

## 设计原则

- **Fail-open**：脚本报错、超时或崩溃时，默认放行（不阻断工作流）
- Hook 适合做提醒和轻量拦截，**不应作为唯一的安全防线**。高风险操作仍需依赖权限审批
- 同一事件匹配多条规则时，所有命中的 hook **并行运行**
- **command 完全相同的多条规则只运行一次**
- Hook 的工作目录 = 当前会话的项目目录
- Hook 进程放在独立进程组，超时时先发 SIGTERM 让其善后，之后才强制终止

## 配置

```toml
[[hooks]]
event = "PreToolUse"       # 必填，触发事件名
matcher = "Bash"           # 可选，正则表达式过滤目标；不填则匹配全部
command = "bash /path/to/hook.sh"   # 必填，要运行的 Shell 命令
timeout = 5                # 可选，超时秒数，范围 1–600；默认 30
```

`[[hooks]]` 只允许这四个字段，多写会导致配置文件加载失败。

## 事件一览

| 事件                 | Matcher 匹配目标                 | 可阻断？               | 说明                                                           |
| -------------------- | -------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `UserPromptSubmit`   | 用户提交的文本内容               | **是**                 | 用户发送消息时触发；返回文本附加到上下文；阻断则本轮不调用模型 |
| `PreToolUse`         | 工具名                           | **是**                 | 工具调用前触发（**权限检查前**）；阻断后工具不执行             |
| `Stop`               | 空字符串                         | **是**                 | 模型准备结束本轮时触发；阻断后可追加一条消息让模型继续         |
| `PostToolUse`        | 工具名                           | 否                     | 工具成功执行后触发                                             |
| `PostToolUseFailure` | 工具名                           | 否                     | 工具失败或被阻断后触发                                         |
| `PermissionRequest`  | 工具名                           | 否                     | 即将等待用户审批前触发                                         |
| `PermissionResult`   | 工具名                           | 否                     | 审批结束后触发                                                 |
| `SessionStart`       | `startup` 或 `resume`            | 否                     | 新会话启动/历史会话恢复后触发                                  |
| `SessionEnd`         | `exit`                           | 否                     | 会话关闭后触发                                                 |
| `SubagentStart`      | 子 Agent 名称                    | 否                     | 子 Agent 开始运行前触发                                        |
| `SubagentStop`       | 子 Agent 名称                    | 否                     | 子 Agent 成功完成后触发                                        |
| `StopFailure`        | 错误类型                         | 否                     | 本轮因错误失败后触发                                           |
| `PreCompact`         | `manual` 或 `auto`               | 否（返回值被完全忽略） | 上下文压缩开始前触发                                           |
| `PostCompact`        | `manual` 或 `auto`               | 否                     | 上下文压缩完成后触发                                           |
| `Notification`       | 通知类型（如 `task\.completed`） | 否                     | 后台任务状态变化时触发                                         |

## 事件数据格式

所有事件都通过 stdin 传入 JSON，基础字段：

```json
{
	"hook_event_name": "PreToolUse",
	"session_id": "session_abc",
	"cwd": "/path/to/project"
}
```

具体事件附带额外字段（字段名使用 `snake_case`）：

### PreToolUse

```json
{
	"hook_event_name": "PreToolUse",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"tool_name": "Bash",
	"tool_input": { "command": "grep -rn TODO src/" }
}
```

Tool-specific `tool_input` shapes:

- **Bash**: `{ "command": "..." }`
- **WriteFile**: `{ "file_path": "..." }`
- **StrReplaceFile**: `{ "file_path": "..." }`
- **ReadFile**: `{ "file_path": "..." }`

### SessionStart / SessionEnd

```json
{
	"hook_event_name": "SessionStart",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"matcher_value": "startup"
}
```

`SessionStart.matcher_value` = `"startup"`（新会话）或 `"resume"`（恢复会话）。
`SessionEnd.matcher_value` = `"exit"`。

### UserPromptSubmit

```json
{
	"hook_event_name": "UserPromptSubmit",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"user_prompt": "请帮我改一下这个文件"
}
```

### Notification

```json
{
	"hook_event_name": "Notification",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"notification": {
		"type": "task.completed",
		"title": "构建完成",
		"body": "npm run build 成功完成"
	}
}
```

### PostToolUse (成功)

```json
{
	"hook_event_name": "PostToolUse",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"tool_name": "Bash",
	"tool_input": { "command": "npm test" },
	"tool_output": "PASS tests/test.js\nTests: 6 passed"
}
```

`tool_output` 为工具输出的前 2000 字符。

### PostToolUseFailure

```json
{
	"hook_event_name": "PostToolUseFailure",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"tool_name": "Bash",
	"tool_input": { "command": "cargo build" },
	"error": { "message": "error[E0308]: mismatched types" }
}
```

### SubagentStart / SubagentStop

```json
{
	"hook_event_name": "SubagentStart",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"agent_name": "coder"
}
```

## 返回值

### 退出码

| 退出码     | 含义           | CLI 处理方式                          |
| ---------- | -------------- | ------------------------------------- |
| **0**      | 正常结束，放行 | stdout 有内容则附加到上下文           |
| **2**      | 主动阻断       | 停止当前操作；**stderr 作为阻断原因** |
| 其他非零值 | 脚本出错       | 默认放行（fail-open）                 |
| 超时/崩溃  | 脚本异常       | 默认放行（fail-open）                 |

> 注意：只有**可阻断事件**（`PreToolUse`、`Stop`、`UserPromptSubmit`）的退出码 2 才会真正阻断流程。其余事件属于观察型事件，退出码 2 被忽略。

### 结构化 JSON 阻断（PreToolUse）

退出码 0 时也可通过 stdout 输出 JSON 来阻断：

```json
{
	"hookSpecificOutput": {
		"permissionDecision": "deny",
		"permissionDecisionReason": "请用 rg 代替 grep"
	}
}
```

## 当前 Hooks 配置（v0.25.0）

| 事件               | Matcher | 脚本                 | 用途                                                                                | 对标 Pi      |
| ------------------ | ------- | -------------------- | ----------------------------------------------------------------------------------- | ------------ |
| `UserPromptSubmit` | —       | `session-context.sh` | **会话上下文一次性注入**：WebSearch 提示 + shazam_overview 项目结构，首次提示时注入 | before-start |

# check-destructive.sh 和 pre-commit-guard.sh 已在 v0.23.0 删除（对应 Pi 的 safety.ts 已移除）

| `PreToolUse` | `Bash` | `pre-commit-verify.sh` | **Pre-commit 提醒**：检测到 git commit 时提醒运行 shazam_verify（不阻断） | precommit-verify (non-blocking) |

| `PreToolUse` | `Bash\|WriteFile\|StrReplaceFile` | `shazam-guide.sh` | **上下文感知**：根据命令模式建议 shazam 工具 | shazam-guide |
| `PreToolUse` | `WriteFile\|StrReplaceFile\|Bash` | `pre-edit-impact-guard.sh` | **Issue 门禁**：P0/bug 类 Issue 未执行 impact 前阻断编辑 | issue-guard |
| `PreToolUse` | `Agent\|AgentSwarm` | `agent-context-guard.sh` | **Agent 上下文门禁**：无结构上下文时阻断 Agent 生成 | agent-context-guard |
| `PostToolUse` | `Bash\|WriteFile\|StrReplaceFile` | `watchdog.sh` | **看门狗**：重复失败检测 + 多文件编辑追踪 + 审计日志 | pre-edit + tool-logger |
| `PostToolUseFailure` | `Bash` | `watchdog.sh` | 失败计数和模式检测 | — |
| `PostToolUse` | `WriteFile\|StrReplaceFile` | `auto-fix.sh` | **自动格式化**：检测配置并运行 prettier/ruff/gofmt/rustfmt | shazam-guide (auto-format) |
| `PostToolUse` | `Bash` | `issue-guard.sh` | **Issue 检测**：gh issue create 后提示运行 impact | issue-guard |
| `PostToolUse` | `mcp__pi-shazam__shazam_impact` | `impact-satisfied.sh` | **Impact 标记清除**：记录 shazam_impact 已完成，解除编辑阻断 | impact-state |
| `PostToolUse` | `mcp__pi-shazam__shazam_verify` | `verify-marker.sh` | **Verify 标记**：记录 shazam_verify 已完成，跳过后续提醒 | verify-state |
| `PostToolUse` | `^mcp__pi-shazam__` | `mcp-audit.sh` | **MCP 审计日志**：记录所有 shazam MCP 调用（JSONL） | tool-logger (audit) |
| `PostToolUseFailure` | `^mcp__pi-shazam__` | `mcp-health.sh` | **MCP 健康监控**：失败时提供逐工具回退建议 | failure-recovery (MCP) |
| `SubagentStart` | — | `mcp-reference.sh` | **MCP 工具参考注入**：向子 Agent 注入工具列表 + CORE RULES + VERIFY SIGNAL | shazam-guide (subagent context) |
| `Stop` | — | `stop-verify.sh` | **验证提醒**：有编辑时提醒运行 shazam_verify（支持 verified 信号） | stop-verify |
| `StopFailure` | — | `stop-failure.sh` | **失败恢复**：记录失败模式 + error-type 分析，从 bash-fail.log 读取实际错误做针对性建议 | failure-recovery |
| `SessionEnd` | — | `session-end.sh` | **会话摘要**：统计、失败模式、未提交提醒，清理临时文件 | baseline |

> **v0.18.0 变更**：新增 `mcp-reference.sh`(SubagentStart) 注入子 Agent 工具参考，`mcp-health.sh`(PostToolUseFailure) MCP 失败回退，`mcp-audit.sh`(PostToolUse) MCP 审计日志；移除重复的 `pre-commit-shazam.sh`（已删除文件，由更完善的 `pre-commit-guard.sh` 替代）；清理 `mcp-reference.sh` 中不可达的 SessionStart 死代码（仅保留 SubagentStart 分支）；修复 `session-end.sh` 缺少 `stop_fail_*` 清理；移除 `issue-guard.sh` 和 `agent-context-guard.sh` LLM 输出中的 emoji

### 对标 Pi 扩展 Hooks（v0.18.0）

| Pi Hook                         | Kimi-Code 对应                                | 关键差异                                                                                      |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `before-start.ts`               | `session-context.sh` (UserPromptSubmit)       | Pi 用 `before_agent_start` event；Kimi-Code 用 `UserPromptSubmit` + 一次性标记                |
| `precommit-verify.ts`           | `stop-verify.sh` (Stop)                       | Pi 自动运行 shazam_verify 并将结果发给 LLM；Kimi-Code 用 stop-verify 事件 + verified 信号提醒 |
| `shazam-guide.ts`               | `shazam-guide.sh`                             | Pi 在 tool_call 事件注入建议；Kimi-Code 在 PreToolUse 事件注入                                |
| `pre-edit.ts`                   | `watchdog.sh` (multi-edit)                    | Pi 用内存 Map 追踪；Kimi-Code 用 temp 文件持久化                                              |
| `shazam-guide.ts` (auto-format) | `auto-fix.sh`                                 | Pi 在 `tool_result` 后自动运行；Kimi-Code 在 `PostToolUse` 后运行                             |
| `stop-verify.ts`                | `stop-verify.sh`                              | Pi 用 `turn_end` 事件；Kimi-Code 用 `Stop` 事件 + verified 文件信号                           |
| `failure-recovery.ts`           | `stop-failure.sh` + `mcp-health.sh`           | Pi 用内存计数器 + error-type 分析；Kimi-Code 读取 watchdog bash-fail.log + MCP 逐工具回退     |
| `issue-guard.ts`                | `issue-guard.sh` + `pre-edit-impact-guard.sh` | Pi 检测 `gh issue create` 命令并设 pending impact flag；Kimi-Code 检测 issue 创建 + 阻断编辑  |
| `agent-context-guard.ts`        | `agent-context-guard.sh`                      | Pi 阻断无结构上下文的 agent 生成；Kimi-Code 阻断无文件引用的 Agent 调用                       |
| `tool-logger.ts`                | `watchdog.sh` (audit) + `mcp-audit.sh`        | Pi 用 JSONL + 调用时长；Kimi-Code 用 bash 审计日志 + MCP JSONL 审计                           |
| `rename-state.ts`               | `impact-satisfied.sh`                         | Pi 内存标记；Kimi-Code 文件标记                                                               |
| `verify-state.ts`               | `verify-marker.sh`                            | Pi 内存标记 + 去重；Kimi-Code 文件标记 + stop-verify 检查                                     |

### Pi 独有优势

| 功能                 | Pi 实现                                | Kimi-Code 限制               |
| -------------------- | -------------------------------------- | ---------------------------- |
| **交互式确认对话框** | `ctx.ui.confirm()` + `ctx.ui.select()` | 只能 exit 2 阻断，无用户选择 |
| **内存状态追踪**     | Map 持久化在 Node.js 进程中            | 需要磁盘文件存储状态         |
| **Auto-format 集成** | 直接调用 `execSync()` 运行 formatter   | 需要 shell 脚本调用          |
| **Turn-end 事件**    | `turn_end` 事件精确检测                | `Stop` 事件可能不够精确      |

### 更新日志（v0.18.0）

1. **新增 mcp-reference.sh**：SubagentStart 注入 MCP 工具参考 + CORE RULES + VERIFY SIGNAL
2. **新增 mcp-health.sh**：MCP 工具失败时提供逐工具回退建议
3. **新增 mcp-audit.sh**：MCP 调用审计日志（JSONL）
4. **移除 pre-commit-shazam.sh**：与 pre-commit-guard.sh 功能重复，后者更完善（5 分钟 TTL + 编辑计数）
5. **更新 shazam-guide.sh matcher**：移除 ReadFile（config.toml 不再匹配）
6. **版本标注更新**：所有脚本 v0.15.x → v0.18.x

## 状态持久化

Kimi-Code hooks 不像 Pi 运行在持久化的 Node.js 进程中，因此：

- 用 `~/.kimi-code/watchdog/` 下的临时文件存状态
- SessionEnd 时清理状态文件
- 用 `md5sum` 或 `cksum` 对命令做稳定哈希

## 注意事项

- **jq 是必需的**，用于解析 stdin JSON。系统已预装。
- **grep 用 POSIX 字符类**：`[[:space:]]` 代替 `\s`，`[0-9]` 代替 `\d`
- **hooks 不能修改 tool input**——只能放行（exit 0）或阻断（exit 2）
- `SessionStart` / `SessionEnd` 的 matcher 为空（匹配全部）
- 观察型事件（PostToolUse 等）即使 exit 2 也不会阻断——它们是"即发即忘"的
- 超时默认 30s，可配范围 1–600s
- `[[hooks]]` 只允许 `event`/`matcher`/`command`/`timeout` 四个字段

## 脚本模板

```bash
#!/usr/bin/env bash
set -eu

INPUT=$(cat)
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$tool_name" == "Bash" ]]; then
  cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  if echo "$cmd" | grep -q "grep"; then
    echo "可以用 shazam_lookup MCP 工具替代 grep"
    exit 0
  fi
fi

exit 0
```

## 维护工作

### 何时需要更新

每当 pi-shazam 升级（新增/重命名/删除工具、变更 hooks 行为、新增语言支持）后，**必须**检查以下 kimi-code shell hooks 是否需要同步更新：

| Hook 脚本                  | 需要检查的内容                                              | 触发条件               |
| -------------------------- | ----------------------------------------------------------- | ---------------------- |
| `mcp-reference.sh`         | 工具列表是否完整、工具名是否正确（MCP 格式 `shazam_` 前缀） | 新增/重命名/删除工具   |
| `shazam-guide.sh`          | 是否缺少新工具的触发建议                                    | 新增工具               |
| `auto-fix.sh`              | formatter 命令是否与 `tools/format.ts` 一致                 | `tools/format.ts` 变更 |
| `stop-verify.sh`           | verify 信号文件路径是否正确                                 | 信号机制变更           |
| `pre-commit-guard.sh`      | 5 分钟 TTL + 编辑计数检测逻辑是否有效                       | 验证流程变更           |
| `pre-edit-impact-guard.sh` | issue 门禁逻辑是否覆盖新 issue 类型                         | issue 模板变更         |
| `issue-guard.sh`           | issue 检测正则是否匹配 gh/glab                              | issue 工具变更         |
| `agent-context-guard.sh`   | 上下文检测规则是否覆盖新 Agent 类型                         | Agent 类型变更         |
| `mcp-health.sh`            | 是否覆盖所有 7 个工具的失败回退建议                         | 工具集变更             |
| `mcp-audit.sh`             | 审计日志路径和格式是否正确                                  | 审计格式变更           |
| `watchdog.sh`              | 编辑追踪是否正确                                            | 工具名或工作流变更     |
| `session-end.sh`           | 会话统计是否完整                                            | 审计格式变更           |

# check-destructive.sh removed in v0.23.0

| `stop-failure.sh` | 错误模式匹配是否覆盖新工具的错误类型 | 工具集变更 |

**同步原则**：

- MCP hook 使用 `mcp__pi-shazam__shazam_<name>` 调用格式
- 所有工具名在 shell hooks 中必须带 `shazam_` 前缀
- `npx` 命令必须加 `--yes` 防止交互式安装卡死
- Biome 命令是 `npx --yes @biomejs/biome check --write`，不是 `npx biome format --write`
- POSIX grep：用 `[[:space:]]` 代替 `\s`，用 `[0-9]` 代替 `\d`
- 编辑追踪用 `~/.kimi-code/watchdog/edits_<session_prefix>` 文件
- MCP 调用无法被 bash-audit.log 检测——不能用它来验证 shazam_verify 是否被调用

### shazam_verify 信号机制

MCP 工具调用不会写入 bash-audit.log，因此 stop-verify.sh 使用**文件信号机制**来检测 shazam_verify 是否已运行：

1. `mcp-reference.sh` 在 SubagentStart 时注入一条规则，格式为：

   ```
   VERIFY SIGNAL: after running shazam_verify, signal completion:
     mkdir -p ~/.kimi-code/watchdog && echo done > ~/.kimi-code/watchdog/verified_<prefix>
   ```

   其中 `<prefix>` 是当前 session_id 的前 12 位（由 hook 脚本从 stdin JSON 实时计算）

2. LLM 跑完 `shazam_verify` 后，执行上述 Bash 命令创建标记文件

3. `stop-verify.sh` 在 Stop 事件时检查：
   - 无编辑 → 跳过
   - 有编辑 + 无 `verified_<prefix>` 标记 → 提醒
   - 有编辑 + 有 `verified_<prefix>` 标记 → 跳过

4. `session-end.sh` 在 SessionEnd 时清理 `verified_<prefix>` 文件

**容错**：如果 LLM 忘记创建标记，stop-verify.sh 仍会触发提醒（"if you already ran it, ignore this"），不会遗漏验证。

### 当前 Hook 版本映射

| pi-shazam 版本 | kimi-code hooks 版本 | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.27.0        | v6（2026-07-06）     | text -> JSON migration (#631 A)：7 个工具现在通过 buildXxxResult 暴露类型化的 XxxResult（dispatcher 选择 markdown 渲染或 JSON envelope 包装）；lookup JSON 输出暴露 Edge.provenance (#643, "resolved" / "name_match" / "heuristic" / "unresolved") 以及 per-edge 计数；shazam_lookup mode=state 完全移除 (#630 cleanup)；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                       |
| v0.25.0        | v6（2026-07-03）     | MCP robustness fixes (#596-#610): LSP cross-platform (PATHEXT, go/bin/.exe, pathToFileURL, symlink containment, per-language timeout), MCP error stack redaction, shazam_lookup existsSync file-path gate, onSignal setImmediate, Windows stdin error/close shutdown triggers; kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                 |
| v0.24.4        | v5（2026-07-02）     | Cross-platform fixes: Windows CI, PATHEXT-aware executable detection, cache directory per platform, POSIX shell -> Node.js in package.json scripts, isExecutable ENOENT warning suppression; kimi-code shell hooks 无变更                                                                                                                                                                                                                                                                                            |
| v0.23.0        | v5（2026-06-29）     | 删除 hooks/safety.ts（破坏性命令检测 + pre-commit gate）；新增 hooks/precommit-verify.ts（自动运行 shazam_verify，不阻断）；所有 hooks 改为非阻断（agent-context-guard 从阻断改为警告，issue-guard 不再设置 pending-impact）；删除 /shazam-toggle-safety 命令；新增 internal.log 内部事件日志；_factory.ts 和 verify.ts 重置图缓存保证数据新鲜；添加 .pi 到 SKIP_DIRS；工具数 7；kimi-code shell hooks v5.1：新增 pre-commit-verify.sh（非阻断提醒），删除 check-destructive.sh 和 pre-commit-guard.sh 的 hooks 配置 |
| v0.22.0        | v4（2026-06-28）     | LSP 可靠性检测 + 错误截断 + JSON lspReliable 字段、subprocess 诊断 regex 解析（行号/列号/错误码）、lookup 符号/文件歧义消解（同名文件风格常数不再误判）、LSP 通知 LRU 淘汰；删除 shazam_find_tests（不可靠，grep/ls 替代）+ shazam_safe_delete（冗余，lookup --direction incoming 替代）；impact find_tests 死代码删除；工具数 9→7；kimi-code shell hooks 无变更（工具名和 MCP 接口不变；mcp-health.sh 检查清单已更新为 7 个工具）                                                                                   |
| v0.21.0        | v4（2026-06-28）     | 新增：overview 数据结构目录 + 增强入口点检测（CLI/HTTP/event），lookup 模糊概念搜索 mode=search + 自然语言自动回退，safety heredoc 误报修复，clearPendingImpact 调用缺失修复；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                  |
| v0.20.3        | v4（2026-06-28）     | 修复 pre-commit gate 误拦提交（测试文件 LSP 误报）+ 11 个测试文件类型错误；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                                                                                                                     |
| v0.20.2        | v4（2026-06-28）     | UX 精化：session_start 时 LSP 状态改用 toast 通知 + 状态栏显示，仅在缺失服务器时发送详细报告；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                                                                                                  |
| v0.20.1        | v4（2026-06-28）     | release script 修复：新增 prettier auto-format step、清理死 sed 命令；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                                                                                                                          |
| v0.20.0        | v4（2026-06-28）     | 功能：LSP setup 报告和 git pre-commit hook 在 session_start 自动执行，用户零配置；Pi 扩展特有改动，MCP 客户端不受影响；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                                                                         |
| v0.19.9        | v4（2026-06-26）     | MCP project root 回退链修复（CLI arg > env > PWD > cwd），解决 ZCode/Cursor 未传项目路径时工作目录错误的问题；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                                                                                  |
| v0.19.8        | v4（2026-06-26）     | MCP server symlink 启动修复：`isMainModule` 改用 `realpathSync` 比较，`package.json` 版本查找支持编译和源码两种目录结构；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                                                                                                                                                       |
| v0.19.7        | v4（2026-06-26）     | 12 个 bug 修复：TOCTOU 竞态、Windows 路径包含、MCP project root 一致性、shazam_format 路径遍历 + 仅限家目录启动、file:// URI 驱动盘符处理、pre-commit + safety 旁路关闭、风险路由修复、O(N\*M) 性能优化、maxTokens 截断、core 数据完整性、agent-context-guard 可选链修复；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                      |
| v0.18.0        | v4（2026-06-23）     | 安全加固：文件符号链接路径遍历防护、impact/find_tests 路径验证、MCP rename dryRun 默认 true + 安全门禁、编码修复（15+ 调用点统一使用 readFileAdaptive）、LSP 进程泄漏修复（shutdown+init 竞态）、图缓存反序列化边界修复、Python `__all__` 三引号匹配修复；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                                                                                      |
| v0.17.0        | v4（2026-06-23）     | 安全修复：safety hook git commit 绕过修复（#394）、MCP shazam_lookup 路径遍历防护；功能修复：验证提醒去重（stop-verify 不再无限重复提醒）、LSP CTS 取消连接、setLspManager async 竞态修复、format 失败静默吞没修复、file:// URI 编码修复；性能优化：反向导入索引 O(N\*M)→O(1)、TreeSitter 适配器单例、并行类型层级请求；kimi-code shell hooks 无变更（工具名和 MCP 接口不变）                                                                                                                                        |
| v0.16.0        | v4（2026-06-23）     | 安全加固：shazam_lookup 路径遍历防护（validatePathInProject）、safety hook RCE 块列表扩展（eval/source/curl\|sh/base64\|sh/反引号/进程替换）；LSP 修复：CTS 取消连接、ensureFileOpened 崩溃恢复、collectDiagnostics O(N²)→O(N)、initialize connection! 竞态；rename_symbol 原子写入；Tree 接口 delete()；中文注释英译；静默 catch 补日志；P3 清理（Unicode/死代码/Set 去重/timer 泄漏/redact 模式）                                                                                                                  |
| v0.15.3        | v3（2026-06-22）     | 工具合并同步：mcp-reference.sh / shazam-guide.sh / mcp-health.sh / stop-failure.sh / agent-context-guard.sh / pre-edit-impact-guard.sh / issue-guard.sh / auto-fix.sh 全部更新为新工具名（shazam_lookup 替代 symbol/file_detail/hover/type_hierarchy，shazam_impact --symbol 替代 call_chain，shazam_format 替代 fix，shazam_overview 包含 hotspots）；shazam_codesearch 移除；新增 shazam_changes 工具引用；config.toml 移除 ReadFile matcher                                                                       |
| v0.14.2        | v2（2026-06-22）     | stop-failure.sh 增强：error-type 分析（file-not-found / permission / network / module-missing），从 bash-fail.log 读取实际错误消息做针对性建议                                                                                                                                                                                                                                                                                                                                                                       |
| v0.13.1        | v1（2026-06-17）     | 批量修复 12 个 issues：LSP shutdown latch 重置、AbortSignal 穿线、diagnostics 并行化、UTF-8 边界修复、core 模块提取（redact/formatters/audit-log）、MCP async verify、Zod schema 补全 maxTokens/json、definitions parity test、函数拆分                                                                                                                                                                                                                                                                              |
| v0.10.6        | v1（2026-06-10）     | MCP LSP 初始化、schema 同步、日志轮转；Pi hooks 无变更                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| v0.9.0         | v1（2026-06-10）     | 新增 JS 支持、修复工具名前缀、添加 lookup/format 建议、修复编辑计数 bug                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| v0.8.0         | v0（2026-06-08）     | 初始创建                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### 检查清单

升级 pi-shazam 后：

1. [ ] 检查 `mcp-reference.sh` 工具列表是否完整、版本号是否正确
2. [ ] 确认 `check-destructive.sh` 和 `pre-commit-guard.sh` 的 hooks 配置已从 config.toml 中移除（safety.ts 已删除）
3. [ ] 检查 `shazam-guide.sh` 是否覆盖所有工具的触发模式
4. [ ] 检查 `auto-fix.sh` formatter 命令是否与 `tools/format.ts` 一致
5. [ ] 检查 `stop-verify.sh` verify 信号机制是否正常工作
6. [ ] 检查 `pre-commit-verify.sh` 提醒逻辑是否正常工作（v0.23.0+ 为非阻断提醒，pre-commit-guard.sh 已删除）
7. [ ] 检查 `mcp-health.sh` 是否覆盖所有 7 个工具的失败回退
8. [ ] 检查 `mcp-audit.sh` 审计日志路径和格式
9. [ ] 检查 `issue-guard.sh` + `pre-edit-impact-guard.sh` issue 门禁逻辑
10. [ ] 检查 `agent-context-guard.sh` 上下文检测规则
11. [ ] 运行 `bash -n` 语法检查所有脚本
12. [ ] 更新本文档中的版本映射表

### 最新更新

| 日期       | 内容                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-06 | v0.27.0 发布：text -> JSON migration (#631 A) + Edge.provenance (#643) + mode=state 移除 (#630 cleanup)，kimi-code shell hooks 无变更                                                                                                             |
| 2026-07-03 | v0.25.0 发布：MCP robustness fixes (#596-#610)，kimi-code shell hooks 无变更                                                                                                                                      |
| 2026-07-02 | v0.24.4 发布：Cross-platform fixes（Windows CI, PATHEXT, cache dir），kimi-code shell hooks 无变更                                                                                                                |
| 2026-06-29 | v0.23.0 发布：删除 hooks/safety.ts + 5 个 slash 命令；新增 precommit-verify.ts（自动 verify）+ internal.log 内部日志；所有 hooks 非阻断；kimi-code hooks v5：移除 check-destructive.sh + pre-commit-guard.sh 配置 |
| 2026-06-28 | v0.22.0 发布：LSP 可靠性检测 + 错误截断 + 工具数 9→7（删除 find_tests/safe_delete）+ review-fixes 5 项，kimi-code shell hooks 无变更                                                                              |
| 2026-06-28 | v0.21.0 发布：数据结构目录 + 入口点检测 + 概念搜索 + heredoc 误报修复，kimi-code shell hooks 无变更                                                                                                               |
| 2026-06-28 | v0.20.3 发布：pre-commit gate 修复 + 测试文件类型错误修复，kimi-code shell hooks 无变更                                                                                                                           |
| 2026-06-28 | v0.20.2 发布：LSP setup UX 精化，toast 通知替代 chat message，kimi-code shell hooks 无变更                                                                                                                        |
| 2026-06-28 | v0.20.1 发布：release script 修复，kimi-code shell hooks 无变更                                                                                                                                                   |
| 2026-06-28 | v0.20.0 发布：自动 setup + git hooks，kimi-code shell hooks 无变更                                                                                                                                                |
| 2026-06-26 | v0.19.9 发布：MCP project root 回退链修复，kimi-code shell hooks 无变更                                                                                                                                           |
| 2026-06-26 | v0.19.8 发布：MCP server symlink 启动修复，kimi-code shell hooks 无变更                                                                                                                                           |
| 2026-06-26 | v0.19.7 发布：12 个 bug 修复（TOCTOU / 路径遍历 / 性能 / 数据完整性），kimi-code shell hooks 无变更                                                                                                               |
| 2026-06-23 | v0.18.0 发布：安全加固、编码修复、图缓存修复，kimi-code shell hooks 无变更                                                                                                                                        |
| 2026-06-23 | v0.17.0 发布：安全修复、验证提醒去重、性能优化，kimi-code shell hooks 无变更                                                                                                                                      |
| 2026-06-22 | v0.15.3 工具合并同步（Kimi Code 全量更新）                                                                                                                                                                        |
