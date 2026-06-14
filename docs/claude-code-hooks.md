---
name: claude-code-hooks
description: "How to write Claude Code hooks (shell scripts triggered by lifecycle events). Covers settings.json hooks setup, stdin JSON protocol, exit codes, all events, and pi-shazam integration. Use when adding hooks to Claude Code."
---

# Claude Code Hooks — Shell Script Lifecycle Handlers

> 来源：官方文档 https://code.claude.com/docs/en/hooks 和 https://code.claude.com/docs/en/hooks-guide

Claude Code hooks 是配置在 `.claude/settings.json`（或 `.claude/settings.local.json`、`~/.claude/settings.json`）中的 Shell 命令，由 27+ 种生命周期事件触发。触发时 CLI 将事件详情打包成 JSON 通过 stdin 传给脚本。

## 与 Kimi Code Hooks 的关键差异

| 特性         | Kimi Code                                 | Claude Code                                                                         |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| 配置格式     | TOML (`config.toml`)                      | JSON (`settings.json`)                                                              |
| 配置位置     | `~/.kimi-code/config.toml`                | `~/.claude/settings.json` / `.claude/settings.json` / `.claude/settings.local.json` |
| 工具名       | `WriteFile`, `StrReplaceFile`, `ReadFile` | `Edit`, `Write`, `Read`                                                             |
| 事件数量     | 15                                        | 27+                                                                                 |
| 阻断方式     | exit 2 或 stdout JSON                     | exit 2 或 stdout JSON                                                               |
| Matcher 语法 | 正则表达式                                | 自动检测（纯字母数字=精确匹配，含特殊字符=JS正则）                                  |
| `if` 过滤    | 不支持                                    | 支持 Permission Rule 语法过滤工具参数                                               |
| Hook 类型    | 仅 command                                | command / http / mcp_tool / prompt / agent                                          |
| 并行执行     | 所有匹配 hook 并行                        | 所有匹配 hook 并行，相同命令自动去重                                                |
| 超时默认     | 30s                                       | command/http/mcp_tool: 600s, UserPromptSubmit: 30s                                  |
| 工作目录     | 项目目录                                  | 项目目录                                                                            |
| 环境变量     | 无特殊变量                                | `$CLAUDE_PROJECT_DIR`, `$CLAUDE_PLUGIN_ROOT` 等                                     |

## 设计原则

- **Fail-open**：脚本报错、超时或崩溃时，默认放行（不阻断工作流）
- Hook 适合做提醒和轻量拦截，**不应作为唯一的安全防线**
- 同一事件匹配多条规则时，所有命中的 hook **并行运行**
- **相同 command 的多条规则只运行一次**（自动去重）
- Hook 的工作目录 = 当前会话的项目目录
- 超时时先发 SIGTERM 让其善后，之后才强制终止

## 配置

配置在 `/home/guojiancheng/.A1/ai/.claude/settings.json` 中（`~/.claude/settings.json` 通过符号链接指向该文件），脚本位于 `/home/guojiancheng/.A1/ai/.claude/hooks/`。

1. **Hook Event**（如 `PreToolUse`、`Stop`）— 生命周期触发点
2. **Matcher Group**（如 `"Bash"`、`"Edit|Write"`）— 过滤触发条件
3. **Hook Handler**（`type: "command"` 等）— 实际执行的命令

### 配置位置

| 位置                          | 作用域     | 可共享               |
| ----------------------------- | ---------- | -------------------- |
| `~/.claude/settings.json`     | 所有项目   | 否（本机）           |
| `.claude/settings.json`       | 单项目     | 是（可提交到 repo）  |
| `.claude/settings.local.json` | 单项目     | 否（自动 gitignore） |
| Managed policy settings       | 组织范围   | 是（管理员控制）     |
| Plugin `hooks/hooks.json`     | 插件启用时 | 是（随插件分发）     |

**本机配置**：全局 hooks 在 `/home/guojiancheng/.A1/ai/.claude/settings.json`（`~/.claude/settings.json` 通过符号链接指向该文件），脚本位于 `/home/guojiancheng/.A1/ai/.claude/hooks/`。

### Matcher 模式

Matcher 决定 hook 何时触发。根据字符内容自动判断匹配方式：

| Matcher 值              | 匹配方式                      | 示例                                                   |
| ----------------------- | ----------------------------- | ------------------------------------------------------ |
| `"*"`, `""`, 或省略     | 匹配全部                      | 每次事件都触发                                         |
| 仅字母、数字、`_`、`\|` | 精确字符串（`\|` 分隔的多值） | `Bash` 精确匹配 Bash；`Edit\|Write` 匹配 Edit 或 Write |
| 包含其他字符            | JavaScript 正则表达式         | `mcp__pi-shazam__.*` 匹配 pi-shazam 所有工具           |

各事件 matcher 匹配的目标：

| 事件                                                                                       | Matcher 过滤目标        | 示例值                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------- |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | 工具名                  | `Bash`, `Edit\|Write`, `mcp__pi-shazam__.*`               |
| `SessionStart`                                                                             | 启动方式                | `startup`, `resume`, `clear`, `compact`                   |
| `SessionEnd`                                                                               | 结束原因                | `clear`, `resume`, `logout`, `prompt_input_exit`, `other` |
| `Notification`                                                                             | 通知类型                | `permission_prompt`, `idle_prompt`, `auth_success`        |
| `SubagentStart` / `SubagentStop`                                                           | agent 类型              | `general-purpose`, `Explore`, `Plan`                      |
| `PreCompact` / `PostCompact`                                                               | 压缩触发方式            | `manual`, `auto`                                          |
| `StopFailure`                                                                              | 错误类型                | `rate_limit`, `server_error`, `max_output_tokens`         |
| `InstructionsLoaded`                                                                       | 加载原因                | `session_start`, `include`, `compact`                     |
| `ConfigChange`                                                                             | 配置来源                | `user_settings`, `project_settings`, `local_settings`     |
| `UserPromptExpansion`                                                                      | 命令名                  | 自定义 skill/command 名                                   |
| `Elicitation` / `ElicitationResult`                                                        | MCP 服务器名            | 已配置的 MCP 服务器名                                     |
| `FileChanged`                                                                              | 字面文件名（`\|` 分隔） | `.envrc\|.env`                                            |

**不支持 matcher**（总是触发）：`UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `MessageDisplay`

### `if` 字段 — 工具参数过滤

Claude Code 独有：`if` 字段使用 [Permission Rule 语法](https://code.claude.com/docs/en/permissions) 按工具名 **和参数** 过滤。仅对工具事件有效。

```json
{
	"type": "command",
	"if": "Bash(git *)",
	"command": "..."
}
```

`if` 匹配规则：

- `Bash(git *)` — 匹配 git 子命令
- `Edit(*.ts)` — 仅匹配 .ts 文件编辑
- `Bash(rm *)` — 匹配 rm 子命令（包括 `$()` 和反引号内的）
- `if` 是 best-effort 过滤，不可解析的 Bash 命令会 fail-open（运行 hook）

## 事件一览

### 完整事件列表

| 事件                  | 触发时机                                   | 可阻断？ | 说明                                  |
| --------------------- | ------------------------------------------ | -------- | ------------------------------------- |
| `SessionStart`        | 会话启动/恢复                              | 否       | matcher: startup/resume/clear/compact |
| `Setup`               | `--init-only` / `--init` / `--maintenance` | 否       | CI/脚本一次性准备                     |
| `UserPromptSubmit`    | 用户提交 prompt 时                         | **是**   | 可阻断 prompt 处理                    |
| `UserPromptExpansion` | 用户命令展开为 prompt 时                   | **是**   | 可阻断展开                            |
| `PreToolUse`          | 工具调用执行前                             | **是**   | 可阻断工具调用                        |
| `PermissionRequest`   | 权限对话框出现时                           | 否       | 可 auto-allow                         |
| `PermissionDenied`    | auto 模式拒绝工具时                        | 否       | 可返回 `{retry: true}`                |
| `PostToolUse`         | 工具调用成功后                             | 否       | 观察型事件                            |
| `PostToolUseFailure`  | 工具调用失败后                             | 否       | 观察型事件                            |
| `PostToolBatch`       | 并行工具批次完成后                         | 否       | 不支持 matcher                        |
| `Notification`        | 系统通知时                                 | 否       | 桌面通知等                            |
| `MessageDisplay`      | Agent 消息文本显示时                       | 否       | 不支持 matcher                        |
| `SubagentStart`       | 子 Agent 启动时                            | 否       | 观察型事件                            |
| `SubagentStop`        | 子 Agent 完成时                            | **是**   | 可阻断子 Agent 停止                   |
| `TaskCreated`         | TaskCreate 创建任务时                      | 否       | 不支持 matcher                        |
| `TaskCompleted`       | 任务标记完成时                             | 否       | 不支持 matcher                        |
| `Stop`                | Claude 完成响应时                          | **是**   | 可阻断停止，继续对话                  |
| `StopFailure`         | 因 API 错误结束时                          | 否       | **stdout 和 exit code 被忽略**        |
| `TeammateIdle`        | Agent 团队队友即将空闲时                   | **是**   | 不支持 matcher                        |
| `InstructionsLoaded`  | CLAUDE.md 加载时                           | 否       | matcher: session_start 等             |
| `ConfigChange`        | 配置文件变化时                             | 否       | matcher: user_settings 等             |
| `CwdChanged`          | 工作目录变化时                             | 否       | 不支持 matcher                        |
| `FileChanged`         | 监听文件变化时                             | 否       | matcher 指定文件名                    |
| `WorktreeCreate`      | worktree 创建时                            | 否       | 任何非零退出码中止创建                |
| `WorktreeRemove`      | worktree 移除时                            | 否       | 不支持 matcher                        |
| `PreCompact`          | 上下文压缩前                               | 否       | 返回值完全忽略                        |
| `PostCompact`         | 上下文压缩后                               | 否       | 观察型事件                            |
| `Elicitation`         | MCP 服务器请求用户输入时                   | 否       | matcher: MCP 服务器名                 |
| `ElicitationResult`   | 用户回应 MCP elicitation 后                | 否       | matcher: MCP 服务器名                 |
| `SessionEnd`          | 会话终止时                                 | 否       | matcher: clear/resume/logout/other    |

### UserPromptSubmit — 关键上下文注入事件

Claude Code 的 `UserPromptSubmit` 是注入上下文的**最佳事件**：

- 支持 matcher（但通常不设置，匹配所有）
- **可阻断**（exit 2）
- stdout 内容**自动追加到 Claude 上下文**

这是对标 Kimi Code `UserPromptSubmit` + Pi `before-start` 的核心事件。

### Stop — 可阻断的回合结束事件

`Stop` 事件是 Claude Code 的**关键差异化功能**：

- **可阻断**（exit 2 让 Claude 继续对话）
- 对标 Kimi Code 的 `Stop` 事件
- 用于实现"编辑后验证提醒"

### MCP 工具匹配

Claude Code 中 MCP 工具名格式为 `mcp__<server>__<tool>`：

- `mcp__pi-shazam__shazam_overview` — pi-shazam overview 工具
- `mcp__pi-shazam__.*` — pi-shazam 所有工具（正则）
- `mcp__.*__write.*` — 所有 MCP 服务器的 write 类工具

> **注意**：`mcp__pi-shazam` 只含字母和下划线，会被当作精确匹配（匹配不到任何工具）。必须用 `mcp__pi-shazam__.*` 正则。

## 事件数据格式 (stdin JSON)

所有事件通过 stdin 传入 JSON，基础字段：

```json
{
	"hook_event_name": "PreToolUse",
	"session_id": "session_abc",
	"transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
	"cwd": "/path/to/project",
	"permission_mode": "default"
}
```

### PreToolUse

```json
{
	"hook_event_name": "PreToolUse",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"tool_name": "Bash",
	"tool_input": { "command": "grep -rn TODO src/" },
	"permission_mode": "default"
}
```

Tool-specific `tool_input` shapes:

- **Bash**: `{ "command": "..." }`
- **Edit**: `{ "file_path": "...", "old_string": "...", "new_string": "..." }`
- **Write**: `{ "file_path": "...", "content": "..." }`
- **Read**: `{ "file_path": "..." }`

### UserPromptSubmit

```json
{
	"hook_event_name": "UserPromptSubmit",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"prompt": "请帮我改一下这个文件"
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

### Stop

```json
{
	"hook_event_name": "Stop",
	"session_id": "session_abc",
	"cwd": "/path/to/project"
}
```

### StopFailure

```json
{
	"hook_event_name": "StopFailure",
	"session_id": "session_abc",
	"cwd": "/path/to/project",
	"error": "rate_limit"
}
```

> **重要**：Claude Code 文档明确指出 StopFailure 的 **stdout 和 exit code 被忽略**，仅用于日志记录。

## 返回值

### 退出码

| 退出码     | 含义           | CLI 处理方式                                                                               |
| ---------- | -------------- | ------------------------------------------------------------------------------------------ |
| **0**      | 正常结束，放行 | stdout 有内容：对于 UserPromptSubmit/SessionStart 附加到上下文；对于其他事件写到 debug log |
| **2**      | 主动阻断       | 停止当前操作；**stderr 作为阻断原因**反馈给 Claude                                         |
| 其他非零值 | 脚本出错       | 默认放行（fail-open），transcript 显示 hook error notice                                   |
| 超时/崩溃  | 脚本异常       | 默认放行（fail-open）                                                                      |

> 只有**可阻断事件**（`PreToolUse`、`Stop`、`UserPromptSubmit` 等）的 exit 2 才会真正阻断流程。

### Exit 2 行为（按事件）

| 事件                | 可阻断？ | Exit 2 效果                   |
| ------------------- | -------- | ----------------------------- |
| `PreToolUse`        | 是       | 阻断工具调用                  |
| `PermissionRequest` | 是       | 拒绝权限                      |
| `UserPromptSubmit`  | 是       | 阻断 prompt 处理，清除 prompt |
| `Stop`              | 是       | 阻止停止，模型继续对话        |
| `SubagentStop`      | 是       | 阻止子 Agent 停止             |
| `TeammateIdle`      | 是       | 阻止队友空闲                  |
| 其他事件            | 否       | stderr 显示给用户，流程继续   |

### 结构化 JSON 输出（exit 0）

```json
{
	"hookSpecificOutput": {
		"hookEventName": "PreToolUse",
		"permissionDecision": "deny",
		"permissionDecisionReason": "Use rg instead of grep"
	}
}
```

`permissionDecision` 值：

- `"allow"` — 跳过交互式权限提示
- `"deny"` — 取消工具调用，reason 反馈给 Claude
- `"ask"` — 显示权限提示给用户（正常流程）

对于 `Stop` 事件，使用 `decision: "block"` 顶层字段。

对于 `UserPromptSubmit`，使用 `additionalContext` 注入文本到 Claude 上下文。

### 合并多个 hook 结果

多个 hook 匹配同一事件时，全部并行执行完毕后合并结果：

- `PreToolUse` permission decision：最严格的胜出（deny > defer > ask > allow）
- `additionalContext` 文本：全部保留合并

## 设计策略：静默 + 自动

**核心原则**：不阻断对话流，不弹出选项让用户选择，一切静默自动完成。

- **安全**：仅拦截真正危险命令（rm -rf /, dd to /dev, mkfs, fork bomb）— exit 2 静默阻断
- **自动格式化**：每次 Edit/Write 后自动运行 prettier/ruff/gofmt/rustfmt
- **自动建议**：编辑后静默注入 verify 提示到 LLM 上下文（LLM 自行决定何时运行）
- **日志追踪**：所有操作静默记录到 `~/.claude/hooks-log/`，用户无感知
- **零交互**：所有 shazam 相关 hook 只通知 LLM 或默认自动运行，不需要用户参与

## 当前 Hooks 配置

| 事件                 | Matcher             | 脚本                   | 用途                                      | 阻断？         |
| -------------------- | ------------------- | ---------------------- | ----------------------------------------- | -------------- |
| `UserPromptSubmit`   | —                   | `session-context.sh`   | 一次性注入工作区雷达 + MCP 工具参考       | 否             |
| `PreToolUse`         | `Bash`              | `check-destructive.sh` | 静默阻断 rm -rf / dd / mkfs / fork bomb   | **是**（安全） |
| `PostToolUse`        | `Bash\|Edit\|Write` | `watchdog.sh`          | 失败追踪 + 编辑计数 + 审计日志 + git 状态 | 否             |
| `PostToolUse`        | `Edit\|Write`       | `shazam-guide.sh`      | 编辑后静默建议 verify（注入 LLM 上下文）  | 否             |
| `PostToolUse`        | `Edit\|Write`       | `auto-fix.sh`          | 自动格式化                                | 否             |
| `PostToolUseFailure` | `Bash`              | `watchdog.sh`          | 失败计数                                  | 否             |
| `Stop`               | —                   | `stop-verify.sh`       | 静默日志（不注入上下文，不阻断）          | 否             |
| `StopFailure`        | —                   | `stop-failure.sh`      | 静默日志                                  | 否             |
| `SessionEnd`         | —                   | `session-end.sh`       | 会话统计 + 清理                           | 否             |

### 对标 Pi 扩展 Hooks

| Pi Hook                         | Claude Code 对应                        | 关键差异                                                                   |
| ------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `before-start.ts`               | `session-context.sh` (UserPromptSubmit) | Pi 用 `before_agent_start`；Claude Code 用 `UserPromptSubmit` + 一次性标记 |
| `safety.ts` (destructive)       | `check-destructive.sh`                  | Pi 用 `ctx.ui.confirm()` 交互；Claude Code 用 exit 2 静默阻断              |
| `shazam-guide.ts` (auto-format) | `auto-fix.sh`                           | Pi 在 tool_result 后自动运行；Claude Code 在 PostToolUse 后运行            |
| `shazam-guide.ts` (suggestions) | `shazam-guide.sh`                       | Pi 用 TypeScript 直接调用；Claude Code 用 shell 脚本注入上下文             |
| `tool-logger.ts`                | `watchdog.sh` (audit)                   | Pi 用 JSONL + 调用时长；Claude Code 用简单文本日志                         |
| `stop-verify.ts`                | `stop-verify.sh`                        | Pi 用 `turn_end` 提醒；Claude Code 静默日志（不阻断不提醒）                |
| `failure-recovery.ts`           | `stop-failure.sh`                       | Pi 用内存计数器；Claude Code 用磁盘文件（StopFailure 仅日志）              |

### Claude Code 独有优势

| 功能                         | Claude Code 实现                                         | Kimi-Code 限制 |
| ---------------------------- | -------------------------------------------------------- | -------------- |
| **exec form + args**         | `"command": "node", "args": ["script.js"]` 无 shell 开销 | 仅 shell form  |
| **`if` 字段**                | `"if": "Bash(git *)"` 按工具参数过滤                     | 不支持         |
| **`${CLAUDE_PROJECT_DIR}`**  | 脚本路径占位符                                           | 需硬编码路径   |
| **MCP tool hooks**           | `"type": "mcp_tool"` 直接调用 MCP                        | 不支持         |
| **HTTP hooks**               | `"type": "http"` POST 到 URL                             | 不支持         |
| **Prompt/Agent hooks**       | `"type": "prompt"` / `"type": "agent"` LLM 决策          | 不支持         |
| **PostToolBatch**            | 并行工具批次完成后触发                                   | 不支持         |
| **自动去重**                 | 相同 command 只运行一次                                  | 手动管理       |
| **CwdChanged / FileChanged** | 目录/文件变化事件                                        | 不支持         |

### Pi 独有优势

| 功能                 | Pi 实现                                | Claude Code 限制        |
| -------------------- | -------------------------------------- | ----------------------- |
| **交互式确认对话框** | `ctx.ui.confirm()` + `ctx.ui.select()` | 只能 exit 2 阻断        |
| **内存状态追踪**     | Map 持久化在 Node.js 进程中            | 需要磁盘文件存储状态    |
| **Turn-end 事件**    | `turn_end` 事件精确检测                | `Stop` 事件可能不够精确 |

## 状态持久化

与 Kimi Code 相同，Claude Code hooks 在独立进程中运行，因此：

- 用 `~/.claude/watchdog/` 下的临时文件存状态
- SessionEnd 时清理状态文件
- 用 `md5sum` 或 `cksum` 对命令做稳定哈希

## 注意事项

- **jq 是必需的**，用于解析 stdin JSON
- **grep 用 POSIX 字符类**：`[[:space:]]` 代替 `\s`，`[0-9]` 代替 `\d`
- **hooks 不能修改 tool input**——只能放行（exit 0）或阻断（exit 2）
- **StopFailure 的 stdout 和 exit code 被完全忽略**——仅用于日志
- 观察型事件（PostToolUse 等）即使 exit 2 也不会阻断——它们是"即发即忘"的
- 超时默认 600s（command），UserPromptSubmit 默认 30s
- **exec form**（`args` 字段）不支持 shell 特性（管道、`&&`、重定向）
- **shell form**（无 `args`）支持完整 shell 特性
- MCP 工具 hook 依赖 MCP 服务器已连接；SessionStart 时可能尚未连接

## 调试 Hooks

```bash
# 查看 hooks 注册状态
claude --debug 2>&1 | grep -i hook

# 或在 Claude Code 内输入
/hooks

# 查看 hook 日志
ls ~/.claude/hooks-log/
tail -f ~/.claude/hooks-log/bash-audit.log

# 手动测试 hook 脚本
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"grep test"},"session_id":"test123","cwd":"'$(pwd)'"}' | bash .claude/hooks/shazam-guide.sh
```

## 脚本模板

```bash
#!/usr/bin/env bash
set -eu

INPUT=$(cat)
tool_name=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$tool_name" == "Bash" ]]; then
  cmd=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  if echo "$cmd" | grep -q "grep"; then
    echo "[shazam] consider using mcp__pi-shazam__shazam_codesearch instead of grep"
    exit 0
  fi
fi

exit 0
```

## 维护工作

### 何时需要更新

每当 pi-shazam 升级（新增/重命名/删除工具、变更 hooks 行为、新增语言支持）后，**必须**检查以下 Claude Code shell hooks 是否需要同步更新：

| Hook 脚本              | 需要检查的内容                           | 触发条件             |
| ---------------------- | ---------------------------------------- | -------------------- |
| `session-context.sh`   | 工具列表是否完整、工具名是否正确         | 新增/重命名/删除工具 |
| Hook 脚本              | 需要检查的内容                           | 触发条件             |
| ---------              | --------------                           | --------             |
| `session-context.sh`   | 工具列表是否完整、工具名是否正确         | 新增/重命名/删除工具 |
| `shazam-guide.sh`      | verify 提示是否准确                      | 验证流程变更         |
| `auto-fix.sh`          | formatter 命令是否与 `tools/fix.ts` 一致 | `tools/fix.ts` 变更  |
| `watchdog.sh`          | 编辑追踪、审计日志是否正确               | 工具名或工作流变更   |
| `session-end.sh`       | 会话统计、清理是否完整                   | 审计格式变更         |
| `check-destructive.sh` | 危险模式是否需要新增                     | 新危险命令发现       |
| `stop-verify.sh`       | 静默日志路径是否正确                     | 路径变更             |
| `stop-failure.sh`      | 日志格式是否正确                         | 审计格式变更         |

### shazam_verify 信号机制

Claude Code hooks 使用文件信号机制（静默版本）：

1. `session-context.sh` 在 UserPromptSubmit 时注入规则（LLM 可自行选择是否创建标记）
2. `shazam-guide.sh` 在每次 Edit/Write 后静默建议 verify（注入 LLM 上下文）
3. `stop-verify.sh` 在 Stop 时仅做静默日志（不阻断，不提醒用户）
4. `session-end.sh` 在 SessionEnd 时清理临时文件

> 与 Kimi Code 的区别：Claude Code 版本不做任何交互式阻断，verify 信号完全由 LLM 自行决定。

### 当前 Hook 版本映射

| pi-shazam 版本 | Claude Code hooks 版本 | 备注                                        |
| -------------- | ---------------------- | ------------------------------------------- |
| v0.10.2        | v2 (2026-06-14)        | 静默策略：零阻断（除安全），自动格式化+建议 |

### 检查清单

升级 pi-shazam 后：

1. [ ] 检查 `session-context.sh` MCP 工具列表是否完整
2. [ ] 检查 `shazam-guide.sh` verify 提示
3. [ ] 检查 `auto-fix.sh` formatter 命令是否与 `tools/fix.ts` 一致
4. [ ] 运行 `bash -n` 语法检查所有脚本
5. [ ] 更新本文档中的版本映射表
6. [ ] 在 Claude Code 中运行 `/hooks` 验证注册状态
