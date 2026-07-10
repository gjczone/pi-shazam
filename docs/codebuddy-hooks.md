# CodeBuddy Hooks Development Guide

This document records CodeBuddy's hook system conventions — events, registration, tool names, paths, and key differences from Kimi Code — for maintaining pi-shazam's shell hooks under `hooks/codebuddy/`.

## Hook Events

CodeBuddy supports the following hook events (defined in `~/.codebuddy/settings.json` `hooks` field):

| Event            | Trigger                                   | pi-shazam hooks                                                                                                                                |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart     | New session or resume                     | `mcp-reference.sh`                                                                                                                             |
| PreToolUse       | Before any tool executes                  | `shazam-guide.sh`, `pre-edit-impact-guard.sh`, `agent-context-guard.sh`, `check-destructive.sh`, `pre-commit-verify.sh`, `pre-commit-guard.sh` |
| PostToolUse      | After tool completes (success or failure) | `watchdog.sh`, `auto-fix.sh`, `issue-guard.sh`, `verify-marker.sh`, `impact-satisfied.sh`, `mcp-audit.sh`, `mcp-health.sh`                     |
| Stop             | Agent stops or reaches turn limit         | `stop-verify.sh`                                                                                                                               |
| SessionEnd       | Session terminates                        | `session-end.sh`                                                                                                                               |
| UserPromptSubmit | User submits a message                    | `session-context.sh`                                                                                                                           |

Note: CodeBuddy has **no** `StopFailure`, `SubagentStart`, `SubagentStop`, `PostToolUseFailure`, or `Notification` events. These are Kimi Code only.

## Registration (`settings.json`)

Hooks are registered in `~/.codebuddy/settings.json` under `hooks.<EventName>[].hooks[]`. Each hook entry specifies a `type: "command"` and `command` with the script path.

Matcher patterns support regex on `tool_name`:

| Matcher                         | Matches                   | Used by                                                                                 |
| ------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `Bash`                          | Bash tool calls only      | `check-destructive.sh`, `pre-commit-verify.sh`, `pre-commit-guard.sh`, `issue-guard.sh` |
| `Edit\|Write\|Bash`             | Code-editing tools + Bash | `shazam-guide.sh`, `pre-edit-impact-guard.sh`, `watchdog.sh`                            |
| `Edit\|Write`                   | Code edits only           | `auto-fix.sh`                                                                           |
| `Task`                          | Agent/Task spawning       | `agent-context-guard.sh`                                                                |
| `mcp__pi-shazam__shazam_verify` | Specific shazam tool      | `verify-marker.sh`                                                                      |
| `mcp__pi-shazam__shazam_impact` | Specific shazam tool      | `impact-satisfied.sh`                                                                   |
| `^mcp__pi-shazam__`             | All shazam MCP tools      | `mcp-audit.sh`, `mcp-health.sh`                                                         |
| (empty)                         | All events/tools          | `session-context.sh`, `mcp-reference.sh`, `stop-verify.sh`, `session-end.sh`            |

## stdin JSON Format

Each hook event receives a JSON object on stdin. Key fields vary by event:

**SessionStart:**

```json
{ "hook_event_name": "SessionStart", "matcher_value": "startup|resume", "session_id": "...", "cwd": "..." }
```

**PreToolUse:**

```json
{ "hook_event_name": "PreToolUse", "tool_name": "Edit|Write|Bash|Task|...", "tool_input": { "command": "...", "file_path": "...", ... }, "session_id": "..." }
```

**PostToolUse:**

```json
{
	"hook_event_name": "PostToolUse",
	"tool_name": "...",
	"tool_output": "...",
	"error": { "message": "..." },
	"session_id": "..."
}
```

CodeBuddy's PostToolUse fires for both success and failure — no separate PostToolUseFailure event. Detect failure by checking `error.message` or error markers in `tool_output`.

**UserPromptSubmit:**

```json
{ "hook_event_name": "UserPromptSubmit", "prompt": "...", "session_id": "..." }
```

## Return Values

- **Exit 0**: Allow. stdout is shown to the LLM as context.
- **Exit 1**: Allow but log error. stderr is recorded.
- **Exit 2**: Auto-deny (no permission prompt). stderr is shown to the LLM as reason.

## Tool Names (CodeBuddy-Specific)

CodeBuddy uses different tool names than Kimi Code. Hook scripts MUST use CodeBuddy names:

| Concept           | CodeBuddy name | Kimi Code name         |
| ----------------- | -------------- | ---------------------- |
| Edit file         | `Edit`         | `StrReplaceFile`       |
| Write/Create file | `Write`        | `WriteFile`            |
| Spawn agent       | `Task`         | `Agent` / `AgentSwarm` |

## Watchdog / Log Paths

```
Watchdog:  ~/.codebuddy/hooks/watchdog/
Log:       ~/.codebuddy/hooks/log/
```

In lib `shazam-common.sh`, these are auto-detected and exported as `SHAZAM_WATCHDOG_DIR` and `SHAZAM_LOG_DIR`. Adapter scripts should use these variables instead of hardcoding paths.

## Key Differences from Kimi Code

| Aspect               | CodeBuddy                                         | Kimi Code                             |
| -------------------- | ------------------------------------------------- | ------------------------------------- |
| SubagentStart        | Missing — use `PreToolUse(Task)` + `SessionStart` | Has native `SubagentStart` event      |
| PostToolUseFailure   | Missing — detect failure in `PostToolUse`         | Has native `PostToolUseFailure` event |
| StopFailure          | Missing (`stop-failure.sh` not registered)        | Has native `StopFailure` event        |
| Edit tool name       | `Edit`                                            | `StrReplaceFile`                      |
| Write tool name      | `Write`                                           | `WriteFile`                           |
| Agent tool name      | `Task`                                            | `Agent` / `AgentSwarm`                |
| Watchdog path        | `~/.codebuddy/hooks/watchdog/`                    | `~/.kimi-code/watchdog/`              |
| Log path             | `~/.codebuddy/hooks/log/`                         | `~/.kimi-code/hooks-log/`             |
| Config file          | `~/.codebuddy/settings.json`                      | `~/.kimi-code/config.toml`            |
| MCP reference inject | `SessionStart` + `PreToolUse(Task)`               | `SubagentStart`                       |

## Maintenance Flow

1. **Shared content changes** (tool list, CORE RULES, REMOVED):
   - Edit `hooks/lib/shazam-common.sh`
   - Run `bash scripts/deploy-hooks.sh` (dry-run) to check diffs
   - Run `bash scripts/deploy-hooks.sh --apply` to deploy

2. **CodeBuddy-specific adapter changes** (event dispatch, tool name matching):
   - Edit `hooks/codebuddy/<name>.sh`
   - Run `bash scripts/deploy-hooks.sh --apply`

3. **Syntax check**: `deploy-hooks.sh` runs `bash -n` on all deployed files automatically.

4. **Drift detection**: `deploy-hooks.sh` warns if `~/.codebuddy/hooks/` has .sh files not present in `hooks/codebuddy/` source directory.
