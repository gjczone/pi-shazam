# API-RULES.md

Rules for the pi-shazam API surface: Pi ExtensionAPI, MCP server, tool definitions,
and output contracts. Read this before adding or modifying any tool, hook, or command.

---

## 1. Pi ExtensionAPI Surface

### 1.1 Lifecycle Events — `pi.on(event, handler)`

pi-shazam subscribes to these events in `index.ts`:

| Event                | Handler Location           | Behavior                                                 |
| -------------------- | -------------------------- | -------------------------------------------------------- |
| `before_agent_start` | `index.ts`                 | Update project root, initialize LSP servers (15s timeout) |
| `session_start`      | `index.ts`                 | Clear rename safety gate state (`clearRenameState()`)     |
| `session_shutdown`   | `index.ts`                 | Shutdown LSP, reset scanner cache, reset lsp_enrich state |
| `tool_execution_end` | `hooks/tool-logger.ts`     | Log tool call duration and result size to audit log       |
| `before_agent_start` | `hooks/before-start.ts`    | Inject system prompt with project overview                |
| `tool_execution_end` | `hooks/pre-edit.ts`        | Track edits for verify reminder gating                    |
| `tool_execution_end` | `hooks/issue-guard.ts`     | Detect GitHub issue creation, set pending impact          |
| `before_agent_start` | `hooks/agent-context-guard.ts` | Inject agent context instructions                    |
| `turn_end`           | `hooks/stop-verify.ts`     | Remind agent to run shazam_verify if edits unverified     |
| `tool_execution_end` | `hooks/failure-recovery.ts` | Handle tool failures gracefully                          |
| `tool_execution_end` | `hooks/safety.ts`          | Pre-commit safety gate enforcement                        |
| `before_agent_start` | `hooks/shazam-guide.ts`    | Inject tool usage guide into system prompt                |

**Rule**: Register `before_agent_start` handlers in the correct order — the one returning
`{ systemPrompt }` must come after `registerBeforeStartHook`. Only the last
`before_agent_start` return value is used.

### 1.2 Slash Commands — `pi.registerCommand(name, { description, handler })`

| Command                      | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `/shazam-setup`              | Detect and report LSP server availability            |
| `/shazam-doctor`             | Health check: tree-sitter, LSP, cache integrity      |
| `/shazam-install-git-hooks`  | Install pre-commit hook (`core/git-hooks.ts`)        |
| `/shazam-remove-git-hooks`   | Remove the shazam pre-commit hook                    |
| `/shazam-pre-commit-verify`  | Run pre-commit verification (used by git hook script)|

**Rule**: Command names are kebab-case. All commands use `pi.sendMessage()` with
`display: true` to show results to the user. The `ctx.ui?.setStatus?.()` call is
optional and defended with `?.`.

### 1.3 Messages — `pi.sendMessage({ customType, content, display })`

```ts
pi.sendMessage({
  customType: "shazam-setup",   // kebab-case, matches command name
  content: report,              // always string (never array)
  display: true,                // user-visible
});
```

**Rule**: Always use `string` for `content`. Never pass the array form
`(TextContent | ImageContent)[]` — pi-shazam convention is string-only.

### 1.4 Logging — `pi.logger`

`pi.logger` does not exist at runtime (the `pi` object is flat). Use `pi.logger?.info?.()`
with optional chaining. For tool-side logging, use `_logWarn(tag, message, err?)` from
`core/output.ts` which prints `[pi-shazam] tag: message - reason`.

**Rule**: Never call `pi.logger.info()` without `?.` — it will throw. All tool code
must use `_logWarn()`, never `console.warn()` directly.

---

## 2. MCP Server Surface

### 2.1 Tool Registration — `server.registerTool("shazam_*", { description, inputSchema, handler })`

MCP tools live in `mcp/tools.ts`. Each tool:

- Name matches Pi tool: `shazam_overview`, `shazam_lookup`, etc. (9 tools total)
- `inputSchema` uses Zod (from `tools/definitions.ts` `zodParams`)
- `handler` returns `{ content: [{ type: "text", text: string }] }`
- Wrapped in `withLogging()` for audit trail (`~/.cache/repomap/shazam-calls.log`)

### 2.2 Transport

stdio JSON-RPC via `@modelcontextprotocol/sdk`. Entry point: `mcp/entry.ts`.
Launched as `node dist/mcp/entry.js <project-root>`.

### 2.3 MCP-Pi Parity

Every MCP tool MUST have a matching Pi tool and vice versa. When changing:
- Tool name → update both `mcp/tools.ts` and the tool's `register*` in `tools/`
- Tool description → sync to both `tools/definitions.ts` and `mcp/tools.ts`
- Tool parameters → update both TypeBox (Pi) and Zod (MCP) schemas

**Rule**: MCP and Pi tools MUST stay in sync in the same PR. Never add a Pi tool
without adding the corresponding MCP tool.

---

## 3. Tool Definition Contract

### 3.1 Shared Definitions — `tools/definitions.ts`

Single source of truth for all 9 tool definitions:

| Tool               | Parameters (TypeBox / Zod)                              |
| ------------------ | ------------------------------------------------------- |
| `shazam_overview`  | `filter?`                                               |
| `shazam_lookup`    | `name`, `file?`, `mode?`, `showCallbacks?`, `direction?`|
| `shazam_impact`    | `files?`, `symbol?`, `withSymbols?`, `compact?`, `depth?`, `flat?`, `direction?` |
| `shazam_verify`    | `quick?`, `lspOnly?`, `preCommit?`, `delta?`, `maxFiles?`, `noCascade?`, `noSecrets?` |
| `shazam_changes`   | *(none)*                                                |
| `shazam_format`    | `dryRun?`, `file?`                                      |
| `shazam_find_tests`| `sourceFile?`, `module?`                                |
| `shazam_rename_symbol` | `symbol`, `newName`, `dryRun?`                       |
| `shazam_safe_delete`  | `symbol`, `dryRun?`                                  |

**Rule**: Both `typeboxParams` (for Pi) and `zodParams` (for MCP) are defined in
`tools/definitions.ts`. Import from here; never duplicate schemas.

### 3.2 TypeBox vs Zod

- **Pi tools**: Use `Type.Object({...})` from `typebox` for `parameters`
- **MCP tools**: Use `z.object({...})` from `zod` for `inputSchema`
- Both schemas describe the same logical shape, but TypeBox uses `Type.Optional(Type.String())`
  while Zod uses `z.string().optional()`

### 3.3 Factory Auto-Merge — `tools/_factory.ts`

`createTool(pi, spec)` automatically merges `json` and `maxTokens` into the parameter schema:

```ts
const mergedSchema = Type.Object({
  ...spec.params.properties,
  json: Type.Optional(Type.Boolean()),
  maxTokens: Type.Optional(Type.Number()),
});
```

**Rule**: Never include `json` or `maxTokens` in your tool's `spec.params` — the factory
adds them. For `customExecute` tools, the factory only merges params; the tool handles
its own envelope, json toggle, and truncation.

### 3.4 execute vs customExecute

- `execute(graph, params)`: For simple domain logic. Factory handles `scanProject(".")`,
  JSON/text toggle, envelope wrapping, and `maxTokens` truncation automatically.
- `customExecute(toolCallId, params, signal, onUpdate, ctx)`: For complex async tools
  (e.g., LSP-dependent tools like `verify`, `rename_symbol`). Tool handles its own
  scanProject, envelope, json toggle, and truncation.

---

## 4. Output Contract

### 4.1 Plain Text (default)

All tools return plain text by default. Format follows the three-section skeleton:

```
## Result Summary
**key:** value

### Detail
- item details

### Next (Required)
- [REQUIRED] label: `shazam_tool --param value`
```

### 4.2 JSON Output — `{ json: true }`

When `json: true`, output is wrapped in the standard envelope:

```json
{
  "schema_version": "1.0",
  "command": "overview",
  "project": "/path/to/project",
  "status": "ok",
  "result": { ... }
}
```

The `command` field strips the `shazam_` prefix (e.g., `shazam_overview` → `overview`).
The `status` is `"ok"` or `"error"`. On error: `{ "result": { "message": "..." } }`.

### 4.3 Truncation — `truncateOutput(lines, maxTokens)`

When `maxTokens` is provided and output exceeds the budget:
- High-priority lines (`##`, `###`, `**key:**`) are always kept
- Low-priority lines are replaced with `... and N more (truncated)`
- Token estimate: ~4 chars per token (`estimateTokens()` in `core/output.ts`)

**Rule**: Truncation only applies to plain text output, never to JSON.

### 4.4 Next Recommendations — `NEXT_RULES` in `core/output.ts`

Adding a new tool requires appending `NextRule` objects to `NEXT_RULES`:

```ts
{
  forTools: ["my_tool"],           // tool names this rule applies to
  condition: (ctx, graph) => ...,  // when to emit
  recommendation: (ctx) => ({      // what to recommend
    tool: "other_tool",
    params: { key: "value" },
    label: "Human-readable label",
    level: "required" | "recommended" | "also",
  }),
}
```

Only `"required"` level recommendations are rendered in output (fixes #112).
Graph-aware filters (`hasTestFiles`, `hasHierarchyKinds`) suppress irrelevant
recommendations when the graph is available.

### 4.5 Path Validation — `validatePathInProject()`

All file path parameters MUST be validated via `validatePathInProject(rawPath, projectRoot)`
from `tools/_factory.ts`. This prevents path traversal attacks using `relative()` +
`isAbsolute()` (platform-agnostic, Windows-safe) and `realpathSync()` (symlink-safe).

---

## 5. Adding a New Tool — Checklist

1. Create `tools/<name>.ts` with `register*(pi: ExtensionAPI)` function
2. Use `createTool(pi, { name, label, description, params, execute })` from `tools/_factory.ts`
3. Tool name MUST be prefixed with `shazam_`
4. Add shared TypeBox + Zod definitions to `tools/definitions.ts`
5. Import and call `register*` in `index.ts` default export
6. Add MCP handler in `mcp/tools.ts` with matching Zod schema
7. Append `NextRule` entries to `NEXT_RULES` in `core/output.ts`
8. Update tool table in `AGENTS.md`, docs in `SKILL.md`, and `README.md`
9. Write tests: at minimum `tests/<name>.test.ts` with AAA pattern
10. Run `npm run typecheck && npm test && npm run build`
