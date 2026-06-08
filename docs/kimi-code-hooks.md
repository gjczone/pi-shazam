---
name: kimi-code-hooks
description: "How to write Kimi Code hooks (shell scripts triggered by lifecycle events). Covers config.toml [[hooks]] setup, stdin JSON protocol, exit codes, all events. Use when adding hooks to Kimi Code's config.toml."
---

# Kimi Code Hooks — Shell Script Lifecycle Handlers

> 来源：官方文档 https://moonshotai.github.io/kimi-code/zh/customization/hooks.html

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

| 事件 | Matcher 匹配目标 | 可阻断？ | 说明 |
|------|-----------------|---------|------|
| `UserPromptSubmit` | 用户提交的文本内容 | **是** | 用户发送消息时触发；返回文本附加到上下文；阻断则本轮不调用模型 |
| `PreToolUse` | 工具名 | **是** | 工具调用前触发（**权限检查前**）；阻断后工具不执行 |
| `Stop` | 空字符串 | **是** | 模型准备结束本轮时触发；阻断后可追加一条消息让模型继续 |
| `PostToolUse` | 工具名 | 否 | 工具成功执行后触发 |
| `PostToolUseFailure` | 工具名 | 否 | 工具失败或被阻断后触发 |
| `PermissionRequest` | 工具名 | 否 | 即将等待用户审批前触发 |
| `PermissionResult` | 工具名 | 否 | 审批结束后触发 |
| `SessionStart` | `startup` 或 `resume` | 否 | 新会话启动/历史会话恢复后触发 |
| `SessionEnd` | `exit` | 否 | 会话关闭后触发 |
| `SubagentStart` | 子 Agent 名称 | 否 | 子 Agent 开始运行前触发 |
| `SubagentStop` | 子 Agent 名称 | 否 | 子 Agent 成功完成后触发 |
| `StopFailure` | 错误类型 | 否 | 本轮因错误失败后触发 |
| `PreCompact` | `manual` 或 `auto` | 否（返回值被完全忽略） | 上下文压缩开始前触发 |
| `PostCompact` | `manual` 或 `auto` | 否 | 上下文压缩完成后触发 |
| `Notification` | 通知类型（如 `task\.completed`） | 否 | 后台任务状态变化时触发 |

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

| 退出码 | 含义 | CLI 处理方式 |
|--------|------|-------------|
| **0** | 正常结束，放行 | stdout 有内容则附加到上下文 |
| **2** | 主动阻断 | 停止当前操作；**stderr 作为阻断原因** |
| 其他非零值 | 脚本出错 | 默认放行（fail-open） |
| 超时/崩溃 | 脚本异常 | 默认放行（fail-open） |

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

## 当前 Hooks 配置（优化后）

| 事件 | Matcher | 脚本 | 用途 | 优化来源 |
|------|---------|------|------|---------|
| `PreToolUse` | `Bash` | `check-destructive.sh` | 阻断 rm -rf / dd / mkfs 等危险命令 | 保留 |
| `SessionStart` | — | `radar-session.sh` | **工作区雷达**：git状态、项目分析、条件化shazam推荐 | 对标 Pi before-start |
| `PreToolUse` | `Bash\|WriteFile\|StrReplaceFile\|ReadFile` | `shazam-guide.sh` | **上下文感知**：根据命令模式建议shazam工具 | 对标 Pi shazam-guide |
| `PostToolUse` | `Bash\|WriteFile\|StrReplaceFile` | `watchdog.sh` | **看门狗**：重复失败检测 + 多文件编辑追踪 + 审计日志 | 对标 Pi pre-edit + tool-logger |
| `PostToolUseFailure` | `Bash` | `watchdog.sh` | 失败计数和模式检测 | 新增 |
| `SessionEnd` | — | `session-end.sh` | **会话摘要**：统计、失败模式、未提交提醒 | 对标 Pi baseline |

### 对标 Pi 扩展 Hooks

| Pi Hook | Kimi-Code 对应 | 关键差异 |
|---------|---------------|---------|
| `before-start.ts` | `radar-session.sh` | Pi 用 tree-sitter 扫描；Kimi-Code 用文件检测 + package.json 解析 |
| `pre-edit.ts` | `watchdog.sh` (multi-edit) | Pi 用内存 Map 追踪；Kimi-Code 用 temp 文件持久化 |
| `shazam-guide.ts` | `shazam-guide.sh` | Pi 在 tool_call/tool_result 事件中通知；Kimi-Code 在 PreToolUse/PostToolUse 中通知 |
| `tool-logger.ts` | `watchdog.sh` (audit) | Pi 用 JSONL + 调用时长；Kimi-Code 用简单日志 |

### 优化点（相比旧版）

1. **radar-session.sh**: 新增项目分析（语言、包管理器、测试框架、依赖、CI）；resume 检测（紧凑输出）；条件化 shazam 推荐
2. **shazam-guide.sh**: 从静态工具列表改为上下文感知建议；PostToolUse 多文件编辑检测
3. **watchdog.sh**: 合并 post-bash.sh + audit-log.sh；新增多文件编辑追踪
4. **session-end.sh**: 新增失败模式分析、未提交变更提醒、编辑统计
5. **删除**: shazam-start.sh（静态列表）、post-bash.sh（合并入 watchdog）、audit-log.sh（合并入 watchdog）

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
    echo "可以用 shazam_codesearch MCP 工具替代 grep"
    exit 0
  fi
fi

exit 0
```
