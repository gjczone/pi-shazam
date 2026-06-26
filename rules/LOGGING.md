# Logging Rules

pi-shazam uses three logging channels depending on the layer. Each channel has a specific API and purpose. Mixing channels or using the wrong one for a layer produces inconsistent output.

## 1. Channel Separation

### core/ layer — `_logWarn`

```ts
// core/output.ts
_logWarn(tag: string, message: string, err?: unknown): void
```

- Output: `console.error("[pi-shazam] [${tag}] ${message}", errDetail)`
- Purpose: warnings and errors only — no informational or debug output
- Used in: all `core/*.ts` files (graph, scanner, pagerank, encoding, treesitter, etc.)
- Must NOT import `pi` or any `ExtensionAPI` — core has zero Pi imports by design

### hooks/ layer — `pi.logger`

```ts
pi.logger.info("shazam_guide", "injected context into LLM");
pi.logger.warn("safety", "blocked write outside project root");
```

- Purpose: informational logging during hook execution (tool execution start, context injection, safety checks)
- `pi.logger.info()` for normal operations (tool calls, context injection)
- `pi.logger.warn()` for degraded states or blocked operations
- hooks/ has access to `ExtensionAPI` so `pi.logger` is available

### MCP/ layer — `console.error`

```ts
console.error("[pi-shazam] [mcp] tool call failed:", err.message);
```

- Purpose: logging in the MCP server process (no `pi.logger` available — MCP runs as a standalone server)
- Prefix with `[pi-shazam] [mcp]` for consistency with core's `_logWarn` format
- Use `console.error` directly — MCP SDK does not provide a logger

## 2. Audit Log

`core/audit-log.ts` provides structured, persistent logging for all tool calls.

**Format**: JSONL (one JSON object per line)

**Rotation policy**:
- Max file size: 10 MB per log file
- Archive count: 5 rotated files (`audit.jsonl`, `audit.jsonl.1`, ... `audit.jsonl.5`)
- Retention: 30 days — older archives are deleted on startup

**What gets logged**:
- Every `shazam_*` tool invocation: tool name, parameters (redacted), timestamp, duration, success/failure
- Session lifecycle: session start, session shutdown
- LSP events: server start, server crash, server timeout

**Written by**: `hooks/tool-logger.ts` calls `auditLog.write(entry)` for each tool call.

## 3. Redaction

`core/redact.ts` strips secrets from strings before they enter any log (audit log, `_logWarn` output, or `pi.logger` calls).

**Patterns matched**:
- API keys: `sk-...`, `api_key=...`, `apikey: ...`
- Bearer tokens: `Bearer ...`, `token=...`
- Passwords: `password=...`, `passwd=...`, `secret=...`
- Environment variables: values of known secret env vars (`OPENAI_API_KEY`, `GITHUB_TOKEN`, etc.)
- Generic hex/base64 tokens longer than 32 characters in sensitive contexts

**Usage**:
```ts
import { redact } from "./redact.js";

_logWarn("scanner", `read config: ${redact(configPath)}`);
auditLog.write({ tool: name, params: redact(JSON.stringify(params)) });
```

**Redact before logging, always.** Even if the current code path seems safe, a future change might pass user data through it.

## 4. Tool Logging

`hooks/tool-logger.ts` logs every `shazam_*` tool call to the audit log.

```ts
// hooks/tool-logger.ts registers on tool_execution_start
pi.on("tool_execution_start", (event) => {
  if (!event.tool.startsWith("shazam_")) return;

  const entry = {
    tool: event.tool,
    params: redact(JSON.stringify(event.params)),
    timestamp: Date.now(),
    sessionId: event.sessionId,
  };

  auditLog.write(entry);
});
```

On `tool_execution_end`, the logger appends duration and result status:
```ts
auditLog.write({
  tool: event.tool,
  duration: event.duration,
  success: !event.error,
  error: event.error?.message,
});
```

## 5. No Emoji in Log Messages

All log messages, audit entries, and error strings must use plain ASCII text. No emoji, no Unicode decorative characters, no ANSI escape codes. This applies to `_logWarn`, `pi.logger`, `console.error` in MCP, and audit log entries.

```
// Correct
_logWarn("graph", "cycle detected in dependency graph");

// Wrong
_logWarn("graph", "cycle detected in dependency graph");
```

## 6. Structured Format

Every log entry follows a consistent structure:

| Field   | Description                                                       |
| ------- | ----------------------------------------------------------------- |
| `tag`   | Source module identifier: `graph`, `scanner`, `pagerank`, `lsp-client`, `lsp-manager`, `encoding`, `treesitter`, `git-utils`, `cache`, `redact`, `audit`, `mcp` |
| `message` | Human-readable description of what happened or what failed      |
| `err`   | Optional — the original error object or message                   |

The `tag` value must match the module name (without extension). Do not invent new tags without updating the tag registry above.

## 7. Performance — No Logging in Hot Paths

Do NOT add logging inside:

- PageRank iteration loops (`core/pagerank.ts` — iterates until convergence)
- Graph traversal (`core/graph.ts` — BFS/DFS over dependency graph)
- Tree-sitter query loops (`core/treesitter.ts` — iterates over captures)
- Cache lookup paths (`core/cache.ts` — called on every tool invocation)

These paths run hundreds or thousands of times per tool call. Logging here degrades performance significantly.

Exception: a single log at the START or END of a hot operation is acceptable (e.g., "PageRank converged after N iterations").

## 8. Log Levels

pi-shazam uses only two levels:

| Level   | API                        | When to use                                           |
| ------- | -------------------------- | ----------------------------------------------------- |
| Warning | `_logWarn` / `pi.logger.warn` / `console.error` | Something failed or degraded, but the operation continues with a fallback |
| Info    | `pi.logger.info`           | Normal operation milestones (tool call started, context injected) — hooks layer only |

No `debug`, `trace`, `verbose`, or `error` levels exist. `_logWarn` handles both warnings and errors — the severity is implied by the message content and whether an `err` object is passed.

Do not add custom log levels, log-level configuration, or runtime verbosity switches. The extension is small enough that structured warnings and audit logs provide sufficient observability.
