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

## 当前 Hooks 配置（v0.9.0 优化后）

| 事件                 | Matcher                                     | 脚本                   | 用途                                                                                    | 优化来源                                        |
| -------------------- | ------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `UserPromptSubmit`   | —                                           | `session-context.sh`   | **会话上下文一次性注入**：工作区雷达 + MCP 工具参考，首次提示时注入                     | 对标 Pi before-start（替代废弃的 SessionStart） |
| `PreToolUse`         | `Bash`                                      | `check-destructive.sh` | 阻断 rm -rf / dd / mkfs 等危险命令                                                      | 保留                                            |
| `PreToolUse`         | `Bash\|WriteFile\|StrReplaceFile\|ReadFile` | `shazam-guide.sh`      | **上下文感知**：根据命令模式建议shazam工具                                              | 对标 Pi shazam-guide                            |
| `PostToolUse`        | `Bash\|WriteFile\|StrReplaceFile`           | `watchdog.sh`          | **看门狗**：重复失败检测 + 多文件编辑追踪 + 审计日志                                    | 对标 Pi pre-edit + tool-logger                  |
| `PostToolUseFailure` | `Bash`                                      | `watchdog.sh`          | 失败计数和模式检测                                                                      | 新增                                            |
| `PostToolUse`        | `WriteFile\|StrReplaceFile`                 | `auto-fix.sh`          | **自动格式化**：检测配置并运行 prettier/ruff/gofmt/rustfmt                              | 对标 Pi shazam-guide auto-format                |
| `PreToolUse`         | `Bash`                                      | `pre-commit-shazam.sh` | **Pre-commit gate**：阻断 git commit 前运行 ruff/tsc 检查                               | 对标 Pi safety pre-commit                       |
| `Stop`               | —                                           | `stop-verify.sh`       | **验证提醒**：有编辑时提醒运行 shazam_verify（支持 verified 信号）                      | 对标 Pi stop-verify                             |
| `StopFailure`        | —                                           | `stop-failure.sh`      | **失败恢复**：记录失败模式 + error-type 分析，从 bash-fail.log 读取实际错误做针对性建议 | 对标 Pi failure-recovery                        |
| `SessionEnd`         | —                                           | `session-end.sh`       | **会话摘要**：统计、失败模式、未提交提醒，清理临时文件                                  | 对标 Pi baseline                                |

> **v0.9.0 变更**：移除 `SessionStart` 和 `SubagentStart` 事件——kimi-code 这些事件属于 observation-only，stdout 被丢弃不会注入对话。改用 `UserPromptSubmit` + `session-context.sh`，通过标记文件实现每会话一次性注入。

### 对标 Pi 扩展 Hooks（v0.9.0 更新）

| Pi Hook                         | Kimi-Code 对应                          | 关键差异                                                                                     |
| ------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `before-start.ts`               | `session-context.sh` (UserPromptSubmit) | Pi 用 `before_agent_start` event；Kimi-Code 用 `UserPromptSubmit` + 一次性标记               |
| `safety.ts` (destructive)       | `check-destructive.sh`                  | Pi 用 `ctx.ui.confirm()` 交互式对话框；Kimi-Code 用 exit 2 直接阻断                          |
| `safety.ts` (pre-commit)        | `pre-commit-shazam.sh`                  | Pi 用 `ctx.ui.select()` 选择 + shazam_verify 门禁；Kimi-Code 仅 ruff/tsc（MCP 调用无法检测） |
| `pre-edit.ts`                   | `watchdog.sh` (multi-edit)              | Pi 用内存 Map 追踪；Kimi-Code 用 temp 文件持久化                                             |
| `shazam-guide.ts` (auto-format) | `auto-fix.sh`                           | Pi 在 `tool_result` 后自动运行；Kimi-Code 在 `PostToolUse` 后运行                            |
| `stop-verify.ts`                | `stop-verify.sh`                        | Pi 用 `turn_end` 事件；Kimi-Code 用 `Stop` 事件 + verified 文件信号                          |
| `failure-recovery.ts`           | `stop-failure.sh`                       | Pi 用内存计数器 + error-type 分析；Kimi-Code 读取 watchdog bash-fail.log 做 error 模式匹配   |
| `tool-logger.ts`                | `watchdog.sh` (audit)                   | Pi 用 JSONL + 调用时长；Kimi-Code 用简单日志                                                 |

### Pi 独有优势

| 功能                 | Pi 实现                                | Kimi-Code 限制               |
| -------------------- | -------------------------------------- | ---------------------------- |
| **交互式确认对话框** | `ctx.ui.confirm()` + `ctx.ui.select()` | 只能 exit 2 阻断，无用户选择 |
| **内存状态追踪**     | Map 持久化在 Node.js 进程中            | 需要磁盘文件存储状态         |
| **Auto-format 集成** | 直接调用 `execSync()` 运行 formatter   | 需要 shell 脚本调用          |
| **Turn-end 事件**    | `turn_end` 事件精确检测                | `Stop` 事件可能不够精确      |

### 优化点（v0.6.4 新增）

1. **safety.ts**: 新增危险命令交互式确认 + Pre-commit gate
2. **shazam-guide.ts**: 新增自动格式化功能（ruff/prettier/gofmt/rustfmt/biome）
3. **stop-verify.ts**: 新增 turn-end 验证提醒
4. **failure-recovery.ts**: 新增连续失败检测和替代方案建议
5. **auto-fix.sh**: 新增自动格式化脚本
6. **pre-commit-shazam.sh**: 新增 Pre-commit gate 脚本

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

| Hook 脚本              | 需要检查的内容                                              | 触发条件               |
| ---------------------- | ----------------------------------------------------------- | ---------------------- |
| `mcp-reference.sh`     | 工具列表是否完整、工具名是否正确（MCP 格式 `shazam_` 前缀） | 新增/重命名/删除工具   |
| `shazam-guide.sh`      | 是否缺少新工具的触发建议                                    | 新增工具               |
| `auto-fix.sh`          | formatter 命令是否与 `tools/format.ts` 一致                 | `tools/format.ts` 变更 |
| `radar-session.sh`     | 工具描述是否准确、推荐列表是否完整                          | 工具描述变更           |
| `stop-verify.sh`       | 审计日志路径是否正确                                        | 日志路径变更           |
| `pre-commit-shazam.sh` | 检查逻辑是否有效                                            | 验证流程变更           |
| `watchdog.sh`          | 编辑追踪是否正确                                            | 工具名或工作流变更     |
| `session-end.sh`       | 会话统计是否完整                                            | 审计格式变更           |
| `check-destructive.sh` | 危险模式是否需要新增                                        | 新危险命令发现         |
| `stop-failure.sh`      | 错误模式匹配是否覆盖新工具的错误类型                        | 工具集变更             |

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

| pi-shazam 版本 | kimi-code hooks 版本 | 备注                                                                                                                                                                                                                                    |
| -------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.14.2        | v2（2026-06-22）     | stop-failure.sh 增强：error-type 分析（file-not-found / permission / network / module-missing），从 bash-fail.log 读取实际错误消息做针对性建议                                                                                          |
| v0.13.1        | v1（2026-06-17）     | 批量修复 12 个 issues：LSP shutdown latch 重置、AbortSignal 穿线、diagnostics 并行化、UTF-8 边界修复、core 模块提取（redact/formatters/audit-log）、MCP async verify、Zod schema 补全 maxTokens/json、definitions parity test、函数拆分 |
| v0.10.6        | v1（2026-06-10）     | MCP LSP 初始化、schema 同步、日志轮转；Pi hooks 无变更                                                                                                                                                                                  |
| v0.9.0         | v1（2026-06-10）     | 新增 JS 支持、修复工具名前缀、添加 lookup/format 建议、修复编辑计数 bug                                                                                                                                                                 |
| v0.8.0         | v0（2026-06-08）     | 初始创建                                                                                                                                                                                                                                |

### 检查清单

升级 pi-shazam 后：

1. [ ] 检查 `mcp-reference.sh` 工具列表是否完整
2. [ ] 检查 `shazam-guide.sh` 是否覆盖所有工具的触发模式
3. [ ] 检查 `auto-fix.sh` formatter 命令是否与 `tools/format.ts` 一致
4. [ ] 检查 `radar-session.sh` 工具描述是否准确
5. [ ] 检查 `stop-verify.sh` 编辑检测是否正确
6. [ ] 检查 `pre-commit-shazam.sh` 检查逻辑是否有效
7. [ ] 运行 `bash -n` 语法检查所有脚本
8. [ ] 更新本文档中的版本映射表
