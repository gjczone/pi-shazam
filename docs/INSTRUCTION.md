# pi-shazam Development & Maintenance Guide

This is the single source of truth for all development, maintenance, and release
activities on pi-shazam. Every contributor and AI agent working on this project
MUST follow this document.

---

## 1. Pi Extension Development Fundamentals

This section documents the Pi coding agent extension API contract, extracted from
`@oh-my-pi/pi-coding-agent@15.9.5` runtime source. It serves as the authoritative
reference for how Pi extensions (plugins) are built. The type stub at
`types/pi-extension.d.ts` derives from this contract.

### 1.1 Extension Factory Function

Every Pi extension is a single default export — a function receiving `ExtensionAPI`:

```ts
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

The `pi` object is a flat plain object. There are NO nested properties like
`pi.logger`, `pi.typebox`, `pi.zod`, or `pi.pi` at runtime. Their presence in
the type stub is for backward compatibility only; access them with `?.` optional
chaining or avoid them entirely.

**pi-shazam MUST NOT depend on these non-existent properties:**

| Property     | Status                                |
| ------------ | ------------------------------------- |
| `pi.logger`  | Does not exist (defended with `?.`)   |
| `pi.typebox` | Does not exist (use direct `import`)  |
| `pi.zod`     | Does not exist (not used)             |
| `pi.pi`      | Does not exist (not used)             |

### 1.2 ExtensionAPI Reference

The complete `ExtensionAPI` interface (from `types/pi-extension.d.ts`):

#### 1.2.1 Core Properties

| Property                          | Type     | Description                  |
| --------------------------------- | -------- | ---------------------------- |
| `on(event, handler)`              | Method   | Subscribe to lifecycle event |
| `registerTool(tool)`              | Method   | Register LLM-visible tool    |
| `registerCommand(name, opts)`     | Method   | Register `/command`          |
| `sendMessage(msg, opts?)`         | Method   | Send custom message          |
| `events`                          | EventBus | Inter-extension communication|

#### 1.2.2 Event Subscription — `pi.on(event, handler)`

| Event                     | Handler Signature                                                                  | Return Value                                 |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| `resources_discover`      | `(e: ResourcesDiscoverEvent, ctx) => ResourcesDiscoverResult \| void`              | `{ skillPaths?, promptPaths?, themePaths? }` |
| `session_start`           | `(e: SessionStartEvent, ctx) => void`                                              | none                                         |
| `session_before_switch`   | `(e: SessionBeforeSwitchEvent, ctx) => SessionBeforeSwitchResult \| void`          | `{ cancel? }`                                |
| `session_switch`          | `(e: SessionSwitchEvent, ctx) => void`                                             | none                                         |
| `session_before_branch`   | `(e: SessionBeforeBranchEvent, ctx) => SessionBeforeBranchResult \| void`          | `{ cancel?, skipConversationRestore? }`      |
| `session_branch`          | `(e: SessionBranchEvent, ctx) => void`                                             | none                                         |
| `session_before_compact`  | `(e: SessionBeforeCompactEvent, ctx) => SessionBeforeCompactResult \| void`        | `{ cancel?, compaction? }`                   |
| `session.compacting`      | `(e: SessionCompactingEvent, ctx) => SessionCompactingResult \| void`              | `{ context?, prompt?, preserveData? }`       |
| `session_compact`         | `(e: SessionCompactEvent, ctx) => void`                                            | none                                         |
| `session_shutdown`        | `(e: SessionShutdownEvent, ctx) => void`                                           | none                                         |
| `session_before_tree`     | `(e: SessionBeforeTreeEvent, ctx) => SessionBeforeTreeResult \| void`              | `{ cancel?, summary? }`                      |
| `session_tree`            | `(e: SessionTreeEvent, ctx) => void`                                               | none                                         |
| `context`                 | `(e: ContextEvent, ctx) => ContextEventResult \| void`                             | `{ messages? }`                              |
| `before_provider_request` | `(e: BeforeProviderRequestEvent, ctx) => BeforeProviderRequestEventResult \| void` | any                                          |
| `after_provider_response` | `(e: AfterProviderResponseEvent, ctx) => void`                                     | none                                         |
| `before_agent_start`      | `(e: BeforeAgentStartEvent, ctx) => BeforeAgentStartEventResult \| void`           | `{ message?, systemPrompt? }`                |
| `agent_start`             | `(e: AgentStartEvent, ctx) => void`                                                | none                                         |
| `agent_end`               | `(e: AgentEndEvent, ctx) => void`                                                  | none                                         |
| `turn_start`              | `(e: TurnStartEvent, ctx) => void`                                                 | none                                         |
| `turn_end`                | `(e: TurnEndEvent, ctx) => void`                                                   | none                                         |
| `message_start`           | `(e: MessageStartEvent, ctx) => void`                                              | none                                         |
| `message_update`          | `(e: MessageUpdateEvent, ctx) => void`                                             | none                                         |
| `message_end`             | `(e: MessageEndEvent, ctx) => void`                                                | none                                         |
| `tool_execution_start`    | `(e: ToolExecutionStartEvent, ctx) => void`                                        | none                                         |
| `tool_execution_update`   | `(e: ToolExecutionUpdateEvent, ctx) => void`                                       | none                                         |
| `tool_execution_end`      | `(e: ToolExecutionEndEvent, ctx) => void`                                          | none                                         |
| `auto_compaction_start`   | `(e: AutoCompactionStartEvent, ctx) => void`                                       | none                                         |
| `auto_compaction_end`     | `(e: AutoCompactionEndEvent, ctx) => void`                                         | none                                         |
| `auto_retry_start`        | `(e: AutoRetryStartEvent, ctx) => void`                                            | none                                         |
| `auto_retry_end`          | `(e: AutoRetryEndEvent, ctx) => void`                                              | none                                         |
| `ttsr_triggered`          | `(e: TtsrTriggeredEvent, ctx) => void`                                             | none                                         |
| `todo_reminder`           | `(e: TodoReminderEvent, ctx) => void`                                              | none                                         |
| `goal_updated`            | `(e: GoalUpdatedEvent, ctx) => void`                                               | none                                         |
| `credential_disabled`     | `(e: CredentialDisabledEvent, ctx) => void`                                        | none                                         |
| `input`                   | `(e: InputEvent, ctx) => InputEventResult \| void`                                 | `{ handled?, text?, images? }`               |
| `tool_call`               | `(e: ToolCallEvent, ctx) => ToolCallEventResult \| void`                           | `{ block?, reason? }`                        |
| `tool_result`             | `(e: ToolResultEvent, ctx) => ToolResultEventResult \| void`                       | `{ content?, details?, isError? }`           |
| `user_bash`               | `(e: UserBashEvent, ctx) => UserBashEventResult \| void`                           | `{ result? }`                                |
| `user_python`             | `(e: UserPythonEvent, ctx) => UserPythonEventResult \| void`                       | `{ result? }`                                |

#### 1.2.3 Tool Registration — `pi.registerTool(tool)`

```ts
interface ToolDefinition<TParams extends TSchema, TDetails = unknown> {
	name: string; // Tool name used in LLM tool calls
	label: string; // Human-readable UI label
	description: string; // Description for LLM (decides when to call)
	parameters: TParams; // TypeBox schema (import from "typebox" directly)
	hidden?: boolean; // Hide unless explicitly listed in --tools
	defaultInactive?: boolean; // Registered but not active by default
	deferrable?: boolean; // Supports deferred changes (resolve/discard)
	mcpServerName?: string; // MCP server name for discovery metadata
	mcpToolName?: string; // Original MCP tool name
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext, // 5th parameter
	): Promise<AgentToolResult<TDetails>>;
	onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>;
	renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component;
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}
```

**Critical: `AgentToolResult` format:**

```ts
interface AgentToolResult<T> {
	content: (TextContent | ImageContent)[]; // ALWAYS an array
	details?: T;
	isError?: boolean;
}
```

**pi-shazam convention**: All tools return `{ content: [{ type: "text", text: string }] }`.

#### 1.2.4 Command Registration — `pi.registerCommand(name, opts)`

```ts
pi.registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}): void;
```

`ExtensionCommandContext` extends `ExtensionContext` with session-control methods:
`newSession()`, `branch()`, `navigateTree()`, `switchSession()`, `waitForIdle()`, `reload()`.

#### 1.2.5 Message Sending — `pi.sendMessage(msg, opts?)`

```ts
sendMessage(message: {
  customType: string;
  content: string | (TextContent | ImageContent)[];  // Both accepted
  display: boolean;
  details?: unknown;
}, options?: {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}): void;
```

**pi-shazam convention**: Always use `string` format for `content`.

#### 1.2.6 Other API Methods

| Method                                          | Purpose                                           |
| ----------------------------------------------- | ------------------------------------------------- |
| `registerShortcut(key, opts)`                   | Register keyboard shortcut                        |
| `registerFlag(name, opts)`                      | Register CLI flag (boolean/string)                |
| `setLabel(entryIdOrLabel, label?)`              | Set extension display label                       |
| `getFlag(name)`                                 | Get registered CLI flag value                     |
| `registerMessageRenderer(customType, renderer)` | Register custom message renderer                  |
| `registerAssistantThinkingRenderer(renderer)`   | Register assistant thinking renderer              |
| `sendUserMessage(content, opts?)`               | Send user message to agent                        |
| `appendEntry(customType, data?)`                | Append custom entry for state persistence         |
| `exec(command, args[], opts?)`                  | Execute shell command                             |
| `getActiveTools()`                              | Get active tool name list                         |
| `getAllTools()`                                 | Get all configured tool names                     |
| `setActiveTools(toolNames)`                     | Set active tools                                  |
| `getCommands()`                                 | Get available slash commands                      |
| `setModel(model)`                               | Set current model                                 |
| `getThinkingLevel()`                            | Get current thinking level                        |
| `setThinkingLevel(level)`                       | Set thinking level                                |
| `getSessionName()`                              | Get current session name                          |
| `setSessionName(name)`                          | Set session name                                  |
| `registerProvider(name, config)`                | Register or override model provider               |
| `events`                                        | Shared EventBus for inter-extension communication |

#### 1.2.7 ExtensionContext

```ts
interface ExtensionContext {
	ui: ExtensionUIContext; // Interactive UI methods
	getContextUsage(): ContextUsage | undefined;
	compact(instructions?): Promise<void>;
	hasUI: boolean;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	modelRegistry: ModelRegistry;
	model: Model | undefined;
	isIdle(): boolean;
	abort(): void;
	hasPendingMessages(): boolean;
	shutdown(): void;
	getSystemPrompt(): string[];
}
```

### 1.3 Content Format Contracts (MANDATORY)

These are verified by the publish-time contract check. Violations cause runtime errors.

| Contract                          | Rule                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| `sendMessage` content             | Use `string` (not array) for pi-shazam                         |
| `before_agent_start` systemPrompt | Return `string` (not `string[]`)                               |
| `registerTool` execute return     | `{ content: [{ type: "text", text: string }] }` — always array |
| TypeBox import                    | `import { Type } from "typebox"` — never `pi.typebox`          |
| Logger access                     | Use `pi.logger?.info()` — never direct `pi.logger.info()`      |

### 1.4 Parameter Schema

TypeBox must be imported directly from the `typebox` package:

```ts
import { Type } from "typebox";

// pi-shazam depends on typebox@^1.1.39 (sinclairzx81's package)
const MyParams = Type.Object({
	path: Type.String(),
	limit: Type.Optional(Type.Number()),
});
```

The `pi.typebox` property does NOT exist at runtime. The Pi runtime resolves
`typebox` imports via jiti.

---

## 2. pi-shazam Architecture

### 2.1 Layer Diagram

```
index.ts                    <- Pi extension entry, default export(pi: ExtensionAPI)
  ├── core/                 <- Pure analysis logic, no Pi dependency
  │   ├── treesitter.ts     <- AST parsing + symbol extraction (6 languages)
  │   ├── graph.ts          <- Symbol dependency graph (imports, calls, references)
  │   ├── pagerank.ts       <- PageRank symbol importance scoring
  │   ├── scanner.ts        <- Project file scanning + graph building
  │   ├── encoding.ts       <- UTF-8 -> GBK -> GB2312 adaptive encoding
  │   ├── filter.ts         <- File filtering (gitignore, binary, size)
  │   ├── output.ts         <- Output formatting, Next recommendations, truncation
  │   └── cache.ts          <- Graph baseline save/diff + persistent V2 graph cache
  ├── lsp/                  <- Language server process management
  │   ├── manager.ts        <- Server lifecycle (spawn, stdio, health, shutdown)
  │   ├── client.ts         <- LSP protocol communication (JSON-RPC via vscode-jsonrpc)
  │   ├── servers.ts        <- Language->server config table (6 languages)
  │   └── setup.ts          <- /shazam-setup command: detect + install guidance
  ├── tools/                <- One file per registerTool call
  │   ├── _context.ts       <- Tool-level shared LspManager holder
  │   ├── _factory.ts       <- createTool() registration factory
  │   ├── lsp_enrich.ts     <- Tool-layer LSP enrichment wrappers
  │   ├── overview.ts       <- Project structure summary
  │   ├── impact.ts         <- File-level change impact
  │   ├── codesearch.ts     <- BM25 symbol search + LSP enrichment
  │   ├── file_detail.ts    <- Single file deep analysis
  │   ├── call_chain.ts     <- Call graph traversal
  │   ├── symbol.ts         <- Symbol lookup
  │   ├── verify.ts         <- Post-edit diagnostics gate
  │   ├── fix.ts            <- Auto-fix lint/format
  │   ├── hotspots.ts       <- Complexity hotspot ranking
  │   ├── hover.ts          <- Symbol type/documentation hover
  │   ├── find_tests.ts     <- Test file discovery
  │   ├── type_hierarchy.ts <- LSP type hierarchy + implementations
  │   ├── rename_symbol.ts  <- Symbol rename
  │   └── safe_delete.ts    <- Safe symbol deletion
  ├── hooks/                <- Automatic (not LLM-visible)
  │   ├── before-start.ts   <- Inject overview into system prompt
  │   ├── pre-edit.ts       <- Detect multi-file edits, warn about blast radius
  │   ├── shazam-guide.ts   <- Auto-format + contextual tool suggestions
  │   ├── safety.ts         <- Destructive command confirmation + pre-commit gate
  │   ├── stop-verify.ts    <- Remind to verify before ending turn
  │   ├── failure-recovery.ts <- Detect consecutive failures, suggest alternatives
  │   ├── tool-logger.ts    <- Log shazam calls to audit dir
  │   ├── issue-guard.ts    <- Detect gh issue create, set pending impact flag
  │   └── agent-context-guard.ts <- Block agent spawn without structural context
  └── mcp/                  <- MCP server for non-Pi clients
      ├── entry.ts          <- McpServer + StdioServerTransport init
      └── tools.ts          <- 14 MCP tool registrations wrapping core
```

### 2.2 Dependency Direction

`hooks/` -> `tools/` -> `core/` + `lsp/`
`mcp/`   -> `core/` + `lsp/`

- `core/` has zero Pi or LSP imports.
- Tools compose core functions and optionally enrich with LSP data.
- Hooks call tool logic directly and inject results into LLM context via `pi.sendMessage()`.
- `mcp/` wraps core directly, bypasses tools layer.

### 2.3 Key Design Principles

1. **Layer boundaries**: `core/` MUST NOT import from `tools/`, `hooks/`, `lsp/`, or `mcp/`.
2. **LSP degradation**: When LSP server is unavailable, fall back to tree-sitter only.
   Annotate output with "(tree-sitter only, LSP unavailable)". Never throw on missing LSP.
3. **Tool naming**: Prefix all tools with `shazam_` to avoid conflicts.
4. **Symbol IDs**: Format as `{file}::{name}::{line}` — stable convention used across tools.
5. **Output format**: All tools return plain text by default, structured JSON when `{ json: true }` is passed. Never mix formats.
6. **Encoding**: Always use `core/encoding.ts` adaptive reader (UTF-8 -> GBK -> GB2312). Never assume UTF-8.
7. **File organization**: One file = one business concept. No files named `utils.ts` or `helpers.ts` over 200 lines.

### 2.4 Layer Details

**core/** — Pure analysis, zero external I/O beyond filesystem reads. No Pi, LSP, or MCP imports.

**lsp/** — External process management for language servers. Spawns, monitors health, handles stdio, implements JSON-RPC with timeout/fallback.

**tools/** — One file per `registerTool` call. Each exports `register*` function + `execute*` function. Use `tools/_factory.ts` `createTool()` factory for consistent registration.

**hooks/** — Automatic event handlers, not LLM-callable. Each exports `register*` function only. Subscribed in `index.ts`.

**mcp/** — MCP server for non-Pi clients (Cursor, Claude Desktop, etc.). Wraps `core/` functions with Zod schemas, not TypeBox.

---

## 3. Development Workflow

### 3.1 Prerequisites

- Node.js >= 18
- npm (package manager)
- `npm install --legacy-peer-deps` (required for tree-sitter grammar peer dependency conflicts)

### 3.2 Daily Development Commands

| Command             | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `npm run typecheck` | Type validation without emit (`tsc --noEmit`) |
| `npm test`          | Run all tests (Vitest)                        |
| `npm run build`     | Compile TS -> `dist/`                         |
| `npm run dev`       | Watch mode incremental compilation            |

### 3.3 Change Workflow (MANDATORY)

For every non-trivial change:

1. **Before touching code**: Run `shazam_overview` to understand current structure.
2. **Before editing a file**: Run `shazam_impact --files <f> --with-symbols` to assess blast radius.
3. **Edit**: Make minimal changes. Do one thing per change.
4. **After editing**: Run `shazam_verify` for evidence gate.
5. **Verification gate**: `npm run typecheck` + `npm test` + `npm run build` — all must pass.

### 3.4 Adding a New Tool

pi-shazam uses a `createTool()` factory from `tools/_factory.ts` that eliminates
per-tool boilerplate. The factory auto-handles: `json`/`maxTokens` params,
`scanProject(".")`, content envelope, and truncation.

**Standard tool (synchronous):**

```typescript
import { createTool } from "./tools/_factory.js";
import { Type } from "typebox";

createTool(pi, {
  name: "shazam_mytool",
  label: "My Tool",
  description: "When to use this tool...",
  params: Type.Object({
    query: Type.String(),
    limit: Type.Optional(Type.Number()),
  }),
  execute(graph, params) {
    return "output string";
  },
});
```

**Async / LSP tool:**

```typescript
createTool(pi, {
  name: "shazam_mytool",
  // ...
  customExecute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const graph = scanProject(".");
    // async + LSP logic here
    return { content: [{ type: "text", text: "result" }] };
  },
});
```

**Registration checklist for a new tool:**

1. Create `tools/<name>.ts` with `register*` function using `createTool()`.
2. Import and call `register*` in `index.ts`.
3. For complex async tools, use `customExecute` instead of `execute`.
4. Append Next recommendation rules to `NEXT_RULES` in `core/output.ts`.
5. Write tests in `tests/`.
6. Update the tool table in `AGENTS.md`.
7. Add docs to `SKILL.md` (Pi agent skill file).
8. Update `README.md` if user-facing tool list changed.
9. Sync `mcp/tools.ts` in the same PR (see §3.11).

**Description style rotation** — vary across 5 styles so the LLM sees variety:

| Style | Example |
|-------|---------|
| Scenario trigger | "When you first enter a project — use this to..." |
| Prerequisite | "Required before editing 2+ files or any shared/exported module" |
| Consequence hint | "Without this you ship bugs — traces ALL upstream callers" |
| Action binding | "After every write or edit — confirm no errors" |
| Anti-pattern warning | "Don't reach for grep — this ranks results by relevance" |

### 3.5 Modifying an Existing Tool

When changing tool schema, description, or output format:

1. Update the `createTool()` call in the tool file.
2. Sync the MCP Zod schema in `mcp/tools.ts` (same PR).
3. Update `SKILL.md` tool docs.
4. Update `AGENTS.md` tool table if description changed.
5. Run `npm test` — verify tool output tests pass.

### 3.6 Adding a New Language

1. Add grammar to `core/treesitter.ts` `EXT_TO_LANG` map.
2. Add tree-sitter query in the queries section.
3. Add LSP server config in `lsp/servers.ts`.

### 3.7 Modifying Core Algorithms

- Changing `core/pagerank.ts` or `core/graph.ts`: verify all tools that consume `RepoGraph` still produce correct output.
- Changing `lsp/client.ts`: verify `lsp/manager.ts` lifecycle still works. Test with at least 2 language servers.
- Changing tool output format: update the specific `tools/*.ts` formatter and verify JSON envelope schema.

### 3.8 Test-Driven Development

Write the failing test FIRST, then implement. This is non-negotiable for features and bugfixes.

### 3.9 Pi Hooks — Lifecycle Event Handlers

Hooks subscribe to Pi lifecycle events via `pi.on()`. They live in `hooks/` and are
registered in `index.ts`. Hooks are NOT LLM-callable — they fire automatically.

**Hook handler signature:** `(event: E, ctx: ExtensionContext) => R | void`

- `ctx.cwd` — working directory
- `ctx.ui?.notify?.(msg, type)` — show notification (use optional chaining)
- `pi.sendMessage(...)` — inject message into conversation
- Return `{ block: true, reason: "..." }` to block a `tool_call`
- Return `{ systemPrompt: string }` from `before_agent_start` to inject text

**Registration pattern:**

```typescript
// hooks/my-hook.ts
import type { ExtensionAPI } from "../types/pi-extension.js";

export function registerMyHook(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    // event.toolName, event.input, ctx.cwd, ctx.sendMessage(), etc.
  });
}
```

```typescript
// index.ts
import { registerMyHook } from "./hooks/my-hook.js";
// inside default export:
registerMyHook(pi);
```

**System prompt injection:**

```typescript
pi.on("before_agent_start", (_event, _ctx) => {
  const sp = Array.isArray(_event.systemPrompt)
    ? _event.systemPrompt.join("\n")
    : String(_event.systemPrompt ?? "");
  if (sp.includes("my-guide")) return; // avoid double injection

  return {
    systemPrompt: sp + "\n\nmy guidance text here",
  };
});
```

**Critical**: `systemPrompt` may be `string` or `string[]` at runtime. Always check with `Array.isArray()`.

**Logging pattern** — follow tool-logger.ts convention, write to `~/.pi/hooks/audit/`:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUDIT_DIR = join(homedir(), ".pi", "hooks", "audit");
function write(line: string) {
  mkdirSync(AUDIT_DIR, { recursive: true });
  appendFileSync(join(AUDIT_DIR, "my-log.log"), line + "\n", "utf-8");
}
```

**Existing hooks in pi-shazam:**

| Hook | Event | Purpose |
|------|-------|---------|
| `before-start.ts` | `before_agent_start` | Inject project structure overview into system prompt |
| `pre-edit.ts` | `tool_call` + `tool_result` | Detect multi-file edits, warn about blast radius |
| `shazam-guide.ts` | `tool_result` + `tool_call` | Auto-format + nudge agent to use shazam tools |
| `tool-logger.ts` | `tool_call` + `tool_result` | Log shazam calls to audit dir |
| `safety.ts` | `tool_call` (bash) | Destructive command confirmation + pre-commit gate |
| `stop-verify.ts` | `tool_result` + `turn_end` | Remind to verify before ending turn |
| `failure-recovery.ts` | `tool_result` | Detect consecutive failures, suggest alternatives |
| `verify-state.ts` | (shared module) | Shared verify tracking state for safety + stop-verify |

### 3.10 MCP Server — Non-Pi Client Wrapping

Wraps pi-shazam core tools as MCP server at `npx pi-shazam-mcp`.

**Entry (`mcp/entry.ts`):**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "pi-shazam", version: "0.11.1" });
const graph = scanProject(projectRoot);
registerAllTools(server, getGraph, projectRoot);
await server.connect(new StdioServerTransport());
```

`package.json` must have: `"bin": { "pi-shazam-mcp": "dist/mcp/entry.js" }`

**Tool registration (`mcp/tools.ts`) — Zod schemas (NOT TypeBox):**

```typescript
import { z } from "zod";

server.registerTool("shazam_xxx", {
  description: "...",
  inputSchema: z.object({ param: z.string() }),
}, withLogging("shazam_xxx", async ({ param }) => {
  const text = executeXxx(graph, param);
  return { content: [{ type: "text", text }] };
}));
```

**`withLogging` wrapper** — logs start/end/duration/error to `~/.kimi-code/audit/shazam-calls.log`.
Every handler must be wrapped.

**MCP client config:**

```json
{ "mcpServers": { "pi-shazam": { "command": "npx", "args": ["pi-shazam-mcp"] } } }
```

### 3.11 Sync Discipline (Pi <-> MCP <-> Docs)

When one piece changes, others MUST follow in the same PR.

**Tool changes:**

| Change | AGENTS.md | SKILL.md | README.md | mcp/tools.ts | mcp/README.md |
|--------|-----------|----------|-----------|-------------|---------------|
| New tool | Add to table | Add full docs | Add if user-facing | Add registerTool | Add to table |
| Delete tool | Remove | Remove | Remove | Remove | Remove |
| Schema change | — | Update params | — | Update Zod | — |
| Description change | Sync | Sync | — | Sync | Sync |
| Rename | Update all | Update all | Update if listed | Update | Update |

**Hook changes:**

| Change | AGENTS.md | AGENTS.md Change Map |
|--------|-----------|---------------------|
| New hook | Add to hooks/ tree | Add to architecture |
| Hook event changed | Update description | — |
| Delete hook | Remove from tree | — |

**Doc changes:**

| Change | Must also update |
|--------|-----------------|
| Architecture | AGENTS.md tree + AGENTS.md |
| Languages supported | README + AGENTS.md + SKILL.md |
| Commands | README + SKILL.md |
| Release | README npm badge auto-updates |

**Before commit checklist:**

- [ ] Pi tools + MCP tools count matches
- [ ] Tool descriptions match between Pi and MCP
- [ ] AGENTS.md tool table synced
- [ ] SKILL.md has all tools documented
- [ ] README.md tool counts correct
- [ ] Architecture tree in AGENTS.md current
- [ ] Language counts verified against code

### 3.12 Code Style

- **Language**: English only in all source code, comments, commit messages, PRs, and issues.
- **No emoji**: No emoji or decorative Unicode in source files, tool output, or commit messages.
  Exceptions: `AGENTS.md` and `SKILL.md`.
- **Tool output**: Minimal, structured, free of noise. No "friendly" filler phrases.
- **File scope**: One file = one business concept. No files named `utils.ts` or `helpers.ts` over 200 lines.

---

## 4. Release & Publish

### 4.1 Publishing Method: GitHub Actions (MANDATORY)

NEVER run `npm publish` directly. Local npm tokens expire. All publishing goes through
`.github/workflows/publish.yml`.

### 4.2 When to Release

After any user-facing change: new tools, new hooks, bugfixes, significant doc updates.

Version strategy:
- **patch** (0.3.0 -> 0.3.1): bugfixes, typos, minor tweaks
- **minor** (0.2.0 -> 0.3.0): new features (tools, hooks, MCP)
- **major** (0.x -> 1.0): breaking changes, API removals

### 4.3 Release Steps

```bash
# 1. Verify everything passes
npm run typecheck
npm test
npm run build

# 2. Bump version (creates git tag)
npm version patch   # or minor / major

# 3. Push code + tags
git push origin main --tags

# 4. Create GitHub Release (triggers publish.yml)
gh release create v0.X.Y \
  --title "v0.X.Y — summary" \
  --notes "## Changes\n- ..."

# 5. Wait for publish CI
gh run watch $(gh run list --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')

# 6. Verify
npm view pi-shazam version  # should show new version

# 7. Test in Pi
cd project && pi install npm:pi-shazam@0.X.Y
pi -p "call shazam_overview briefly"
```

### 4.4 Publish CI (.github/workflows/publish.yml)

Triggered by GitHub Release event. Runs:
1. `npm ci --legacy-peer-deps`
2. `npx tsc --noEmit` (typecheck)
3. `npm test`
4. `npm run build`
5. `npm publish` (with `secrets.NPM_TOKEN`)
6. Wait 15s -> `npm view pi-shazam` verify

**NOTE**: `secrets.NPM_TOKEN` is a GitHub repository secret (npm Automation Token, no 2FA).

### 4.5 Pre-Release Checklist

- [ ] All tests pass locally
- [ ] Typecheck passes (0 errors)
- [ ] Build compiles
- [ ] `shazam_verify` passes on test project
- [ ] README / AGENTS.md / SKILL.md synced
- [ ] MCP tools synced with Pi tools
- [ ] No stale branches or worktrees

### 4.6 Pre-Publish Contract Check (MANDATORY)

Before every release, run these checks against `dist/`:

```
grep "pi\.logger\." dist/          # No unprotected direct calls
grep "pi\.typebox" dist/           # No references
grep "content:" dist/index.js      # sendMessage: string format
grep "content:" dist/hooks/*.js    # sendMessage: string format
grep "content:" dist/tools/*.js    # Tool return: [{type:"text", text:...}]
grep "systemPrompt:" dist/hooks/   # Returns string, not string[]
```

### 4.7 Post-Release

```bash
pi install npm:pi-shazam@latest   # update Pi
pi -p "call shazam_overview"      # smoke test
```

---

## 5. Tech Stack Management

### 5.1 Current Dependencies

| Package                        | Version          | Latest | Status       |
| ------------------------------ | ---------------- | ------ | ------------ |
| typescript                     | ^6.0.3 (6.0.3)   | 6.0.3  | Current      |
| vitest                         | ^4.1.8 (4.1.8)   | 4.1.8  | Current      |
| tree-sitter                    | ^0.22.4 (0.22.4) | 0.25.0 | Pinned       |
| vscode-languageserver-protocol | ^3.18.0 (3.18.0) | 3.18.0 | Current      |
| vscode-jsonrpc                 | ^9.0.0 (9.0.0)   | 9.0.0  | Current      |
| typebox                        | ^1.2.1 (1.2.1)   | 1.2.1  | Current      |
| iconv-lite                     | ^0.7.2 (0.7.2)   | 0.7.2  | Current      |
| @types/node                    | ^22.0.0 (22.x)   | 25.9.2 | Behind major |

### 5.2 Tree-Sitter Grammars

| Grammar                | Current | Latest | Status       |
| ---------------------- | ------- | ------ | ------------ |
| tree-sitter-c          | 0.23.4  | 0.24.1 | Behind minor |
| tree-sitter-c-sharp    | 0.23.1  | 0.23.5 | Behind patch |
| tree-sitter-cpp        | 0.23.4  | 0.23.4 | Current      |
| tree-sitter-css        | 0.23.1  | 0.25.0 | Behind major |
| tree-sitter-go         | 0.23.4  | 0.25.0 | Behind major |
| tree-sitter-html       | 0.23.2  | 0.23.2 | Current      |
| tree-sitter-java       | 0.23.5  | 0.23.5 | Current      |
| tree-sitter-javascript | 0.23.1  | 0.25.0 | Behind major |
| tree-sitter-json       | 0.24.8  | 0.24.8 | Current      |
| tree-sitter-python     | 0.23.6  | 0.25.0 | Behind major |
| tree-sitter-ruby       | 0.23.1  | 0.23.1 | Current      |
| tree-sitter-rust       | 0.23.2  | 0.24.0 | Behind minor |
| tree-sitter-typescript | 0.23.2  | 0.23.2 | Current      |

### 5.3 Upgrade Policy

- **tree-sitter core**: Pinned at 0.22.4 via `overrides` in `package.json`.
  Upgrading to 0.25.x requires coordinated upgrade of ALL tree-sitter grammars
  and verification that the new API (which has breaking changes) is compatible.
  Do NOT upgrade tree-sitter alone.
- **tree-sitter grammars**: Must stay compatible with tree-sitter 0.22.4.
  Grammar versions 0.23.x are the compatibility ceiling for tree-sitter 0.22.x.
  Grammars at 0.24.x/0.25.x require tree-sitter 0.25.x.
- **Other dependencies**: Upgrade freely within semver when tests pass.
  Run `npm run typecheck` + `npm test` + `npm run build` after any upgrade.
- **vscode-languageserver-protocol**: Minor bump 3.17.0 -> 3.18.0 is likely safe.
  Test LSP communication with at least Python and TypeScript servers.

---

## 6. Testing

### 6.1 Test Framework

vitest, 301 tests across 27 test files. Run: `npm test`

### 6.2 Graph Mock Pattern

```typescript
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";

let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
  if (!_graph) _graph = scanProject(".");
  return _graph;
}
```

Use `scanProject(".")` for real-project tests (cached after first call).

### 6.3 Tool Output Tests

```typescript
it("should return project structure summary", async () => {
  const { executeOverview } = await import("../tools/overview.js");
  const result = executeOverview(getGraph(), ".");
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
  expect(result.length).toBeGreaterThan(0);
  expect(result).toMatch(/index\.ts|Top|PageRank/i);
});
```

### 6.4 Schema Tests (Zod / MCP)

```typescript
it("overview schema should accept optional filter", () => {
  const schema = z.object({ filter: z.string().optional() });
  expect(() => schema.parse({})).not.toThrow();
  expect(() => schema.parse({ filter: "index" })).not.toThrow();
});
```

### 6.5 Integration Smoke Tests

```bash
# Pi integration
pi install npm:pi-shazam@latest
pi -p "call shazam_overview briefly"
pi -p "call shazam_verify"
pi -p "call shazam_hotspots"
# Check: no "Extension error" in output, tools return meaningful results.

# MCP smoke test
printf '{"jsonrpc":"2.0","id":0,"method":"initialize",...}\n{"jsonrpc":"2.0","id":1,"method":"tools/call",...}\n' \
  | timeout 15 node dist/mcp/entry.js . 2>/dev/null | tail -1
# Verify: {"result":{"content":[...]}}
```

### 6.6 Hook Verification

```bash
# Verify hooks registered in built dist
grep -c "registerShazamGuide\|registerToolLogger\|registerBeforeStart\|registerSafetyHooks\|registerStopVerify\|registerPreEditGuard\|registerFailureRecovery\|registerIssueGuard\|registerAgentContextGuard" dist/index.js
# Should output: 9
```

### 6.7 After Every Change (MANDATORY)

| Step | Command             | What It Checks |
| ---- | ------------------- | -------------- |
| 1    | `npm run typecheck` | Type safety    |
| 2    | `npm test`          | All unit tests |
| 3    | `npm run build`     | Compile output |

### 6.8 Debugging Guide

| Symptom                               | Check                                               |
| ------------------------------------- | --------------------------------------------------- |
| Extension fails to load               | Compare against `docs/INSTRUCTION.md` §1 contract   |
| `text.replace is not a function`      | Check sendMessage content is string, not array      |
| `Cannot read properties of undefined` | Check pi.logger/pi.typebox/ctx.ui access            |
| Tool not appearing                    | Verify register* is called in index.ts              |
| Tree-sitter parse failure             | Check grammar version compatibility                 |
| LSP communication error               | Check lsp/client.ts JSON-RPC framing                |

---

## 7. Key Files Reference

| File                      | Role                                   |
| ------------------------- | -------------------------------------- |
| `index.ts`                | Extension entry, all registrations     |
| `types/pi-extension.d.ts` | Self-contained ExtensionAPI type stub  |
| `AGENTS.md`               | Agent context and project rules        |
| `SKILL.md`                | Pi agent skill file for LLM discovery  |
| `package.json`            | npm manifest, dependencies, scripts    |
| `tsconfig.json`           | TypeScript compiler configuration      |
| `docs/INSTRUCTION.md`     | This file — development & maintenance guide |
| `docs/kimi-code-hooks.md` | Kimi Code hook system reference (external) |
| `core/treesitter.ts`      | Language support, symbol extraction    |
| `core/graph.ts`           | Symbol dependency graph                |
| `core/scanner.ts`         | Project scanning + graph building      |
| `lsp/client.ts`           | LSP JSON-RPC implementation            |
| `tools/_factory.ts`       | Tool registration factory              |
| `tools/_context.ts`       | Shared LspManager holder               |
| `hooks/before-start.ts`   | System prompt injection                |

---

## 8. Modification Log

| Date       | Version | Change                                                                                                                                                                                     |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-06-06 | 1.0     | Initial version. Merged Pi ExtensionAPI contract, project architecture, dev workflow, release process, tech stack baseline.                                                                |
| 2026-06-06 | 1.1     | Upgraded iconv-lite (0.6.3 -> 0.7.2), typebox (1.1.39 -> 1.2.1), vscode-languageserver-protocol (3.17.0 -> 3.18.0).                                                                       |
| 2026-06-08 | 2.0     | Merged all individual SKILL.md files (pi-extension, pi-hooks, mcp-server, testing, release-publish, architecture, sync-discipline) and CONTRACT.md. Flattened docs/ directory.             |
