# pi-shazam Development & Maintenance Guide

This is the single source of truth for all development, maintenance, and release
activities on pi-shazam. Every contributor and AI agent working on this project
MUST follow this document.

---

## 1. Pi Extension Development Fundamentals

This section documents the Pi coding agent extension API contract, extracted from
`@oh-my-pi/pi-coding-agent@15.9.5` runtime source. It serves as the authoritative
reference for how Pi extensions (plugins) are built.

### 1.1 Extension Factory Function

Every Pi extension is a single default export — a function receiving `ExtensionAPI`:

```ts
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

The `pi` object is a flat plain object. There are NO nested properties like
`pi.logger`, `pi.typebox`, `pi.zod`, or `pi.pi` at runtime. Their presence in
the type stub is for backward compatibility only; access them with `?.` optional
chaining or avoid them entirely.

### 1.2 ExtensionAPI Reference

The complete `ExtensionAPI` interface (from `types/pi-extension.d.ts`):

#### 1.2.1 Event Subscription — `pi.on(event, handler)`

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

#### 1.2.2 Tool Registration — `pi.registerTool(tool)`

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

#### 1.2.3 Command Registration — `pi.registerCommand(name, opts)`

```ts
pi.registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}): void;
```

`ExtensionCommandContext` extends `ExtensionContext` with session-control methods:
`newSession()`, `branch()`, `navigateTree()`, `switchSession()`, `waitForIdle()`, `reload()`.

#### 1.2.4 Message Sending — `pi.sendMessage(msg, opts?)`

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

#### 1.2.5 Other API Methods

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

#### 1.2.6 ExtensionContext

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
  │   ├── treesitter.ts     <- AST parsing + symbol extraction (18 languages)
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
  │   ├── routes.ts         <- HTTP route inventory
  │   ├── state_map.ts      <- State definition discovery
  │   ├── verify.ts         <- Post-edit diagnostics gate
  │   ├── fix.ts            <- Auto-fix lint/format
  │   ├── ready.ts          <- Pre-commit readiness
  │   ├── check.ts          <- Compiler/lint diagnostics
  │   ├── hotspots.ts       <- Complexity hotspot ranking
  │   ├── hover.ts          <- Symbol type/documentation hover
  │   ├── find_tests.ts     <- Test file discovery
  │   ├── type_hierarchy.ts <- LSP type hierarchy + implementations
  │   ├── rename_symbol.ts  <- Symbol rename
  │   └── safe_delete.ts    <- Safe symbol deletion
  └── hooks/                <- Automatic (not LLM-visible)
      ├── before-start.ts   <- Inject overview into system prompt
      └── after-write.ts    <- Auto verify + fix after write/edit
```

### 2.2 Dependency Direction

`hooks/` -> `tools/` -> `core/` + `lsp/`

- `core/` has zero Pi or LSP imports.
- Tools compose core functions and optionally enrich with LSP data.
- Hooks call tool logic directly and inject results into LLM context via `pi.sendMessage()`.

### 2.3 Key Design Principles

1. **Layer boundaries**: `core/` MUST NOT import from `tools/`, `hooks/`, or `lsp/`.
2. **LSP degradation**: When LSP server is unavailable, fall back to tree-sitter only.
   Annotate output with "(tree-sitter only, LSP unavailable)". Never throw on missing LSP.
3. **Tool naming**: Prefix all tools with `shazam_` to avoid conflicts.
4. **Symbol IDs**: Format as `{file}::{name}::{line}` — stable convention used across tools.
5. **Output format**: All tools return plain text by default, structured JSON when `{ json: true }` is passed. Never mix formats.
6. **Encoding**: Always use `core/encoding.ts` adaptive reader (UTF-8 -> GBK -> GB2312). Never assume UTF-8.

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

1. **Before touching code**: Run `repomap overview` to understand current structure.
2. **Before editing a file**: Run `repomap impact --files <f> --with-symbols` to assess blast radius.
3. **Edit**: Make minimal changes. Do one thing per change.
4. **After editing**: Run `repomap verify` for evidence gate.
5. **Verification gate**: `npm run typecheck` + `npm test` + `npm run build` — all must pass.

### 3.4 Adding a New Tool

1. Create `tools/<name>.ts` with a `register*` function.
2. Use `createTool(pi, { name, label, description, params, execute })` from `tools/_factory.ts`.
3. Import and call `register*` in `index.ts`.
4. For complex async tools, use `customExecute` instead of `execute`.
5. Append Next recommendation rules to `NEXT_RULES` in `core/output.ts`.
6. Write tests in `tests/`.

### 3.5 Adding a New Language

1. Add grammar to `core/treesitter.ts` `EXT_TO_LANG` map.
2. Add tree-sitter query in the queries section.
3. Add LSP server config in `lsp/servers.ts`.

### 3.6 Modifying Core Algorithms

- Changing `core/pagerank.ts` or `core/graph.ts`: verify all tools that consume `RepoGraph` still produce correct output.
- Changing `lsp/client.ts`: verify `lsp/manager.ts` lifecycle still works. Test with at least 2 language servers.
- Changing tool output format: update the specific `tools/*.ts` formatter and verify JSON envelope schema.

### 3.7 Test-Driven Development

Write the failing test FIRST, then implement. This is non-negotiable for features and bugfixes.

### 3.8 Code Style

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

### 4.2 Release Steps

1. Complete development, all tests pass.
2. `npm version patch` (or `minor`/`major`) — auto-creates git tag.
3. `git push origin <branch> --tags`
4. Create PR -> merge to main.
5. Create GitHub Release: `gh release create vX.Y.Z`
6. Release event auto-triggers `.github/workflows/publish.yml`.
   - Manual trigger alternative: `gh workflow run publish.yml --ref main -f tag=latest`

### 4.3 CI Pipeline (publish.yml)

- `npm ci --legacy-peer-deps`
- `npx tsc --noEmit` (type check)
- `npm test` (unit tests)
- `npm run build` (compile)
- `npm publish` (with `secrets.NPM_TOKEN`)
- Wait 15s, then `npm view pi-shazam` verification

### 4.4 Pre-Publish Contract Check (MANDATORY)

Before every release, run these checks against `dist/`:

```
grep "pi\.logger\." dist/          # No unprotected direct calls
grep "pi\.typebox" dist/           # No references
grep "content:" dist/index.js      # sendMessage: string format
grep "content:" dist/hooks/*.js    # sendMessage: string format
grep "content:" dist/tools/*.js    # Tool return: [{type:"text", text:...}]
grep "systemPrompt:" dist/hooks/   # Returns string, not string[]
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

## 6. Verification Matrix

### 6.1 After Every Change (MANDATORY)

| Step | Command             | What It Checks |
| ---- | ------------------- | -------------- |
| 1    | `npm run typecheck` | Type safety    |
| 2    | `npm test`          | All unit tests |
| 3    | `npm run build`     | Compile output |

### 6.2 Before Commit

Run `repomap verify` for full evidence gate: changes, risk, orphan symbols,
LSP diagnostics, graph diff (when baseline exists).

### 6.3 Debugging Guide

| Symptom                               | Check                                           |
| ------------------------------------- | ----------------------------------------------- |
| Extension fails to load               | Compare against CONTRACT.md, verify API version |
| `text.replace is not a function`      | Check sendMessage content is string, not array  |
| `Cannot read properties of undefined` | Check pi.logger/pi.typebox/ctx.ui access        |
| Tool not appearing                    | Verify register\* is called in index.ts         |
| Tree-sitter parse failure             | Check grammar version compatibility             |
| LSP communication error               | Check lsp/client.ts JSON-RPC framing            |

### 6.4 Integration Testing

Symlink `dist/` into `~/.pi/agent/extensions/pi-shazam` and verify tool calls
in a live Pi session. Use `~/.A1/repomap` as test target (Python + tree-sitter + LSP).

---

## 7. Key Files Reference

| File                      | Role                                   |
| ------------------------- | -------------------------------------- |
| `index.ts`                | Extension entry, all registrations     |
| `CONTRACT.md`             | Pi ExtensionAPI authoritative contract |
| `types/pi-extension.d.ts` | Self-contained ExtensionAPI type stub  |
| `AGENTS.md`               | Agent context and project rules        |
| `SKILL.md`                | Pi agent skill file for LLM discovery  |
| `package.json`            | npm manifest, dependencies, scripts    |
| `tsconfig.json`           | TypeScript compiler configuration      |
| `core/treesitter.ts`      | Language support, symbol extraction    |
| `core/graph.ts`           | Symbol dependency graph                |
| `core/scanner.ts`         | Project scanning + graph building      |
| `lsp/client.ts`           | LSP JSON-RPC implementation            |
| `tools/_factory.ts`       | Tool registration factory              |
| `hooks/before-start.ts`   | System prompt injection                |
| `hooks/after-write.ts`    | Auto verification after edits          |

---

## 8. Modification Log

| Date       | Version | Change                                                                                                                                                                                     |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-06-06 | 1.0     | Initial version. Merged Pi ExtensionAPI contract (CONTRACT.md, types/pi-extension.d.ts, pi-coding-agent@15.9.5), project architecture, dev workflow, release process, tech stack baseline. |
| 2026-06-06 | 1.1     | Upgraded iconv-lite (0.6.3 -> 0.7.2), typebox (1.1.39 -> 1.2.1), vscode-languageserver-protocol (3.17.0 -> 3.18.0). All 178 tests pass.                                                    |
