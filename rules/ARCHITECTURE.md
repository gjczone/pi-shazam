# ARCHITECTURE.md

pi-shazam is a 4-layer TypeScript codebase that provides codebase analysis as Pi extension tools and MCP tools. The layers enforce strict dependency direction to keep the core engine free of platform-specific imports.

---

## 1. Layer Diagram

```
hooks/          (13 files)
  |                \
  v                 v
tools/          (13 files) ---> lsp/     (4 files)
  |
  v
core/           (16 files)
```

Additional layers:
- `mcp/` (3 files) -- mirrors all 9 tools for non-Pi agents. Imports from core/, tools/, lsp/.
- `types/` (1 file) -- self-contained ExtensionAPI type stub. Zero dependencies.
- `index.ts` -- composition root. Imports from all layers.

---

## 2. Layer Responsibilities

### core/ (16 files) -- Analysis Engine

Pure domain logic. Zero Pi ExtensionAPI, zero LSP, zero MCP imports. Every other layer composes from core.

| File | Responsibility |
|------|---------------|
| `graph.ts` | `Symbol`, `Edge`, `RepoGraph` data model, serialization (V2), snapshot comparison |
| `scanner.ts` | Directory walk, tree-sitter parse, edge building, incremental mtime-based rescan, disk cache, `getEffectiveRoot()` project root override |
| `treesitter.ts` | `TreeSitterAdapter` -- grammar loading, parse, symbol/import/call/ref extraction per language |
| `treesitter-queries.ts` | Tree-sitter query strings for each supported language (7 languages) |
| `pagerank.ts` | PageRank computation on `RepoGraph` |
| `output.ts` | `_logWarn`, `truncateOutput`, `NEXT_RULES` (declarative recommendation engine), section builders (`formatResultSummary`, `formatFileItem`, `buildToolOutput`), token estimation, `getGitChangeCount`, `getGraphSummary` |
| `encoding.ts` | Adaptive file reader (UTF-8 -> GBK -> GB2312 fallback via iconv-lite), sync and async variants |
| `cache.ts` | Persistent graph cache save/load (`~/.pi/cache/pi-shazam/`) |
| `filter.ts` | `SKIP_DIRS` set (node_modules, .git, dist, build, etc.) |
| `formatters.ts` | Shared text formatters for tool output |
| `redact.ts` | Secret redaction (API keys, tokens, passwords) before output |
| `risk.ts` | Risk classification for changed symbols |
| `baseline.ts` | Baseline snapshot for change detection |
| `audit-log.ts` | Audit log rotation (`~/.pi/hooks/audit/`) |
| `git-hooks.ts` | Git pre-commit hook install/remove/verify |
| `git-utils.ts` | Git command wrappers (diff, status, branch detection, etc.) |

### tools/ (13 files) -- Tool Layer

Compose core functions, optionally enrich with LSP data. Each tool file exports a `register*` function. Use `createTool` from `_factory.ts` for registration.

| File | Tool Name | Registration | Key Dependencies |
|------|-----------|-------------|-----------------|
| `_factory.ts` | (shared) | `createTool()` factory, `buildEnvelope()`, `validatePathInProject()`, `isPathInRoot()` | core: scanner, output |
| `_context.ts` | (shared) | `getLspManager()`, `setLspManager()`, `awaitPreviousShutdown()` | lsp: manager |
| `definitions.ts` | (shared) | `getToolDefinition()` -- dual TypeBox/Zod param schemas | typebox, zod |
| `overview.ts` | `shazam_overview` | `registerOverview` | core: graph, scanner, output, pagerank |
| `lookup.ts` | `shazam_lookup` | `registerLookup` | core: graph, treesitter; lsp: client |
| `impact.ts` | `shazam_impact` | `registerImpact` | core: graph, pagerank |
| `verify.ts` | `shazam_verify` | `registerVerify` | core: graph, scanner, git-utils, risk; lsp: client |
| `changes.ts` | `shazam_changes` | `registerChanges` | core: graph, baseline, git-utils |
| `format.ts` | `shazam_format` | `registerFormat` | core: scanner |
| `find_tests.ts` | `shazam_find_tests` | `registerFindTests` | core: graph, scanner |
| `rename_symbol.ts` | `shazam_rename_symbol` | `registerRenameSymbol` | core: graph; lsp: client (LSP textDocument/rename) |
| `safe_delete.ts` | `shazam_safe_delete` | `registerSafeDelete` | core: graph |
| `lsp_enrich.ts` | (shared) | LSP enrichment helpers for tools | lsp: client, manager |

### lsp/ (4 files) -- Language Server Protocol Client

Manages LSP server processes for 7 languages (TypeScript, JavaScript, Python, Go, Rust, Dart, JSON). Graceful degradation: when any server is unavailable, tree-sitter analysis continues without interruption.

| File | Responsibility |
|------|---------------|
| `manager.ts` | `LspManager` class -- language detection, server lifecycle, shutdown, restart budget, crash recovery, path containment checks |
| `client.ts` | `LspClient` -- JSON-RPC over stdio via `vscode-jsonrpc/node` (`StreamMessageReader`/`StreamMessageWriter` + `createMessageConnection`). Handles initialize/didOpen/didChange/didSave/diagnostics/references/definition/rename/hover/workspaceSymbols |
| `servers.ts` | `LSP_SERVER_SPECS` -- server binary names, args, root markers, per-language timeouts, `languageForSuffix()` mapping |
| `setup.ts` | `generateSetupReport()` -- detect available LSP servers, report missing ones with install instructions |

### hooks/ (13 files) -- Lifecycle Hooks

Subscribe to Pi lifecycle events (`before_agent_start`, `session_start`, `tool_execution_start`, `tool_execution_end`, `pre_edit`, `session_shutdown`). Call tool logic and inject results into LLM context via `pi.sendMessage()`.

| File | Lifecycle Event | Responsibility |
|------|----------------|---------------|
| `before-start.ts` | `before_agent_start` | Return `systemPrompt` with available tools list and usage instructions |
| `tool-logger.ts` | `tool_execution_start` | Log tool calls to audit file (`~/.pi/hooks/audit/`) |
| `shazam-guide.ts` | `tool_execution_start` | Inject shazam usage guide when first shazam tool is called in a session |
| `pre-edit.ts` | `pre_edit` | Warn if editing a file that is a high PageRank dependency target |
| `safety.ts` | `tool_execution_start` | Destructive command detection (rm -rf, dd, fork bombs, curl|sh, eval); pre-commit gate blocking `git commit` without recent `shazam_verify` |
| `stop-verify.ts` | `session_shutdown` | Remind agent to run verification before session ends |
| `failure-recovery.ts` | `tool_execution_end` | Detect failed tool calls, suggest recovery steps |
| `issue-guard.ts` | `pre_edit` | Warn when editing files mentioned in active GitHub issues |
| `agent-context-guard.ts` | `before_agent_start` | Validate agent context has required fields (cwd, etc.) |
| `rename-state.ts` | (state module) | Track which symbols have had impact analysis run (rename safety gate) |
| `verify-state.ts` | (state module) | Track verification results across session |
| `impact-state.ts` | (state module) | Track impact analysis results across session |
| `_bash-utils.ts` | (shared) | Bash command tokenization and extraction utilities for hooks |

### mcp/ (3 files) -- MCP Server

Exposes the same 9 analysis tools via Model Context Protocol for non-Pi agents (Cursor, Claude Desktop, Windsurf).

| File | Responsibility |
|------|---------------|
| `entry.ts` | MCP server entry point (`npx pi-shazam-mcp`), project root validation, LSP init, shutdown handlers (SIGTERM/SIGINT/stdin close) |
| `tools.ts` | `registerAllTools()` -- registers all 9 tools on McpServer with Zod schemas, path validation via `validatePathInProject`, audit logging |
| `README.md` | MCP tool documentation and usage examples |

### types/ (1 file)

| File | Responsibility |
|------|---------------|
| `pi-extension.d.ts` | Self-contained `ExtensionAPI` type stub extracted from Pi coding agent runtime. Defines `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`, `AgentToolUpdateCallback`, `ExtensionCommandContext` |

---

## 3. Dependency Direction -- Strict DAG

The layer graph is a directed acyclic graph. No circular dependencies.

```
index.ts (composition root)
  imports from: all layers

hooks/ -> tools/ -> core/
hooks/ -> tools/ -> lsp/ -> core/
hooks/ -> core/ (output only, for _logWarn)
mcp/ -> core/ + tools/ + lsp/ + hooks/rename-state.ts
```

**Specific constraints:**
- `core/` imports only from `core/` and `node:` built-ins and npm packages.
- `lsp/` imports from `core/` (encoding, filter, output) and `node:` built-ins and npm packages. Does NOT import from `tools/` or `hooks/`.
- `tools/` imports from `core/` and `lsp/`. Does NOT import from `hooks/`.
- `hooks/` imports from `tools/`, `core/`, `lsp/`, and `types/`. Accesses Pi via `ExtensionAPI`.
- `mcp/` imports from `core/`, `tools/`, `lsp/`, and `hooks/rename-state.ts` (shared state).
- `index.ts` imports from all layers -- it is the composition root and the only place where all layers converge.

**Enforcement:** `tsc` does not catch cross-layer violations. Verify manually before every commit by checking import statements.

---

## 4. Data Flow

### Extension Initialization (`index.ts`)

```
default export(pi: ExtensionAPI)
  1. Create LspManager(projectRoot, log)
  2. setLspManager(lspManager) -- share with tools via tools/_context.ts
  3. Register lifecycle handlers:
     a. before_agent_start -> update projectRoot if ctx.cwd differs
                             -> awaitPreviousShutdown()
                             -> lspManager.detectLanguages()
                             -> lspManager.initializeAll() with 15s timeout
     b. session_shutdown    -> lspManager.shutdown()
                             -> resetCache() on scanner
                             -> resetLspEnrichState()
     c. session_start       -> clearRenameState()
  4. Register all 9 hooks (order matters: before-start must come after LSP init handler)
  5. Register all 5 slash commands
  6. Register all 9 tools via createTool()
```

### Tool Call (Pi mode)

```
LLM calls shazam_overview
  -> factory merges json/maxTokens params into TypeBox schema
  -> factory calls scanProject(".")
    -> scanner walks files (SKIP_DIRS filtered)
    -> tree-sitter parses each file -> extracts symbols + edges
    -> PageRank computed on the graph
    -> disk cache checked/saved (~/.pi/cache/pi-shazam/)
  -> factory calls tool.execute(graph, params)
  -> tool returns plain text (or JSON if json:true)
  -> factory wraps in AgentToolResult envelope
  -> factory applies truncateOutput() if maxTokens set
  -> LLM receives result
```

### Tool Call (MCP mode)

```
MCP client sends tools/call
  -> mcp/tools.ts handler
    -> validatePathInProject(params.path, projectRoot)
    -> calls execute* function from tools/*.ts
    -> audit logging via logMCP
  -> returns { content: [{ type: "text", text }] }
```

### LSP Lifecycle

```
before_agent_start
  -> detectProjectLanguages(projectRoot) -- checks file extensions in project
  -> lspManager.initializeAll() with 15s timeout guard
    -> for each detected language:
       -> findLspServerBinary(spec) -- checks project-local, PATH, user home
       -> new LspClient(command, args, cwd)
       -> client.start() -> spawn child process
       -> client.initialize() -> JSON-RPC initialize request
       -> re-open previously tracked files (didOpen)
    -> on timeout: lspManager.shutdown() to clean up partial spawns

tool call needs LSP data
  -> getLspManager().getServerForFile(filePath)
    -> match file extension to language
    -> return existing LspClient or create new one
    -> restart budget prevents rapid retry after failure

session_shutdown
  -> lspManager.shutdown() with 8s per-server timeout
  -> resetCache() on scanner (core/scanner.ts)
  -> resetLspEnrichState() (tools/lsp_enrich.ts)
```

### Graph Cache Strategy

```
scanProject(path)
  1. Check in-memory cache (same process, mtime match) -> return immediately
  2. Check disk cache (~/.pi/cache/pi-shazam/graph-cache.json)
     a. All file mtimes match cached mtimes -> return cached graph
     b. Some changed -> incremental scan (re-parse only changed files, merge into cached graph)
  3. No cache -> full scan (walk + parse all files) -> compute PageRank -> save to disk
```

---

## 5. Shared Patterns

### `_logWarn` (core/output.ts)

Standard warning mechanism across all layers. Suppresses ENOENT silently (expected when optional binaries are missing). Prints concise one-line for other errors: `[pi-shazam] tag: message - reason`. Never passes raw Error objects to console.

```typescript
_logWarn("scanner", `Failed to parse ${filePath}`, err);
```

### `NEXT_RULES` (core/output.ts)

Declarative recommendation engine. Each rule: `{ forTools, condition(ctx, graph?), recommendation(ctx) }`. Adding a new tool = appending rules to this array, not editing a switch. Rules evaluate against `NextContext` + optional `RepoGraph` for graph-aware filters (`hasTestFiles`, `hasHierarchyKinds`).

### `buildToolOutput` / `formatResultSummary` / `formatFileItem` (core/output.ts)

Standard output section builders. All tools produce a three-section skeleton:
1. `## Result Summary` -- key-value pairs
2. `### Detail` -- per-item expansion
3. `### Next` -- actionable tool recommendations (only "required" level shown)

### `truncateOutput` / `estimateTokens` (core/output.ts)

Token budget management. Uses ~4 chars/token heuristic. Preserves high-priority lines (headers, key-value pairs). Replaces overflow with `... and N more (truncated)`.

### `createTool` (tools/_factory.ts)

Factory eliminates per-tool boilerplate: param merging, scan, envelope, JSON toggle, truncation. Two modes: `execute` (simple) and `customExecute` (complex async).

### `buildEnvelope` (tools/_factory.ts)

Standard JSON envelope: `{ schema_version, command, project, status, result }`.

### `validatePathInProject` / `isPathInRoot` (tools/_factory.ts)

Path traversal guard. Uses `relative()` + `isAbsolute()` for cross-platform correctness (works with Windows backslash paths). Prevents symlink escape via `realpathSync`.

### `_context.ts` (tools/)

Holds the `LspManager` reference at the tools/ layer (not core/), preserving the dependency direction. Set during extension init in `index.ts`, read by LSP-using tools.

### Definitions Pattern (tools/definitions.ts)

Single source of truth for all tool parameter schemas. Provides both TypeBox schemas (for Pi registration) and Zod schemas (for MCP registration). MCP and Pi tools MUST stay in sync.

---

## 6. Session Lifecycle

The full session event sequence, in order:

```
1. Extension load
   index.ts default export runs
   -> LspManager created
   -> setLspManager() shares reference with tools
   -> all hooks registered
   -> all tools registered
   -> all commands registered

2. before_agent_start (Pi fires this before first LLM turn)
   -> [index.ts inline handler] MUST run first:
      - Update projectRoot from ctx.cwd if differs from process.cwd()
      - awaitPreviousShutdown() (waits for prior session's LSP shutdown)
      - lspManager.detectLanguages() + lspManager.initializeAll() with 15s timeout
   -> [registerBeforeStartHook] Returns systemPrompt with tools list
   -> [registerAgentContextGuard] Validates required context fields

3. session_start (Pi fires on new session)
   -> [index.ts inline handler] clearRenameState()

4. tool_execution_start (Pi fires before each tool call)
   -> [registerToolLogger] Logs tool call to audit file
   -> [registerShazamGuide] Injects usage guide on first shazam call
   -> [registerSafetyHooks] Blocks dangerous commands, enforces pre-commit gate

5. pre_edit (Pi fires before file edits)
   -> [registerPreEditGuard] Warns if editing high-dependency files
   -> [registerIssueGuard] Warns if editing files in active issues

6. tool_execution_end (Pi fires after tool call completes)
   -> [registerFailureRecovery] Detects failures, suggests recovery

7. turn_end (Pi fires at end of each LLM turn)
   -> [registerStopVerify] Reminds agent to verify before session ends

8. session_shutdown (Pi fires when session ends)
   -> [index.ts inline handler]:
      - lspManager.shutdown() with 8s per-server timeout
      - resetCache() on scanner
      - resetLspEnrichState()
   -> [registerStopVerify] Final verification reminder
```

**Critical ordering constraint:** The `before_agent_start` LSP init handler in `index.ts` MUST be registered before `registerBeforeStartHook(pi)`. Only the before-start handler returns `{ systemPrompt }`. If registered after, the system prompt is injected before LSP servers are ready.

---

## 7. No Circular Dependencies

Verification checklist:

| From    | Allowed Imports                     | Forbidden Imports            |
| ------- | ----------------------------------- | ---------------------------- |
| core/   | core/, node:, npm                   | tools/, hooks/, lsp/, mcp/   |
| lsp/    | core/, node:, npm                   | tools/, hooks/, mcp/         |
| tools/  | core/, lsp/, types/, node:, npm     | hooks/, mcp/                 |
| hooks/  | tools/, core/, lsp/, types/, pi     | mcp/                         |
| mcp/    | core/, tools/, lsp/, hooks/rename-state.ts, node:, npm | -- |
| index.ts| all layers (composition root)       | --                           |

The only cross-layer hook dependency: `mcp/` may import `hooks/rename-state.ts` for shared session state. All other hook state is private to hooks/.

---

## 8. File Counts

| Layer   | Source Files | Test Files |
| ------- | ------------ | ---------- |
| core/   | 16           | ~20        |
| tools/  | 13           | ~15        |
| hooks/  | 13           | ~10        |
| lsp/    | 4            | ~5         |
| mcp/    | 3            | ~3         |
| types/  | 1            | 0          |
| root    | 1 (index.ts) | 0          |
| Total   | 51           | ~53        |
