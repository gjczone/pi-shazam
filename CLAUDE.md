# pi-shazam

> **DEVELOPMENT RULE: All development and maintenance of this project MUST follow
> the conventions, workflows, and contracts defined in [INSTRUCTION.md](./INSTRUCTION.md).
> This includes Pi extension API contracts, architecture layer boundaries, tool
> registration patterns, content format contracts, release process, and verification
> gates. INSTRUCTION.md is the single source of truth for how to build and maintain
> pi-shazam. Read it before making any change.**

Pi coding agent native codebase awareness extension. "Shazam" — like the superhero whose power comes from multiple deities, pi-shazam unifies the strength of multiple analysis engines (repomap/aider, pi-lens, serena MCP, tree-sitter, LSP) into one coherent interface for the agent.

Rewrites the Python CLI project [repomap](https://github.com/gjczone/repomap) as a native Pi extension in TypeScript. All analysis capabilities register as first-class Pi tools — LLM sees them alongside `read`/`write`/`bash` with no distinction.

## Project Snapshot

- **Runtime**: TypeScript on Node.js ≥18, ES2022 target, NodeNext module resolution, ESM (`"type": "module"`)
- **Package**: npm `pi-shazam`, entry `dist/index.js` (default export function receiving `ExtensionAPI`)
- **Primary user flow**: LLM calls analysis tools (`overview`, `impact`, `codequery`, etc.) to understand code structure, change impact, and call chains before making edits
- **Architecture**: 4 layers — `core/` (parsing, graph, ranking), `lsp/` (language server management), `tools/` (Pi tool wrappers), `hooks/` (automatic verification)
- **External dependency**: Language servers (pyright, tsserver, rust-analyzer, gopls) are user-installed; pi-shazam manages process lifecycle
- **Release artifact**: npm package with `dist/` compiled output

## Commands

| Command | Purpose |
|---------|---------|
| `npm install --legacy-peer-deps` | Install dependencies (legacy-peer-deps required for tree-sitter) |
| `npm run build` | Compile TS → `dist/` |
| `npm run typecheck` | `tsc --noEmit` — type validation without emit |
| `npm run dev` | `tsc --watch` — incremental compilation |
| `npm publish` | **禁止直接使用**——发布统一通过 GitHub Actions（见 Release & Publish 流程） |

## Development Environment

- Node.js ≥18, npm as package manager
- `types/pi-extension.d.ts` provides self-contained `ExtensionAPI` type stub (extracted from Pi coding agent runtime at `~/.pi/`, scope `@earendil-works/pi-*`)
- `npm install --legacy-peer-deps` required due to tree-sitter grammar peer dependency conflicts
- `tree-sitter@^0.22.4` pinned via `overrides` in package.json
- `vscode-languageserver-protocol` for LSP type definitions
- `iconv-lite` for UTF-8/GBK/GB2312 encoding fallback
- Test the extension by symlinking `dist/` into `~/.pi/agent/extensions/pi-shazam` or configuring in Pi settings

## Dependency API Reference (context7 verified 2026-06)

### tree-sitter (node-tree-sitter v0.22.4)

- **Parser**: `import Parser from "tree-sitter"` → `new Parser()` → `parser.setLanguage(new Language(grammarModule))`
- **Parsing**: `parser.parse(sourceString)` returns `Tree`; `tree.rootNode` for root `SyntaxNode`
- **Query**: `new Query(language, queryString)` → `query.captures(node)` returns `{name: string, node: SyntaxNode}[]`
- **无 QueryCursor**: Node.js binding 没有 Python 版的 `QueryCursor` 类，直接用 `query.captures()`
- **Node 属性**: `node.type`, `node.text`, `node.children`, `node.parent`, `node.previousSibling`, `node.startPosition`/`endPosition`（`.row`/`.column`）, `node.childForFieldName("name")`
- **Grammar 加载**: `new Language(grammarModule)` 包装 native module，不是 Python 的 `Language(fn())` 构造器模式
- **输入类型**: `parse()` 接受 `string` 或回调 `(index, position) => string | null`，不接受 Buffer
- **无内置 .d.ts**: 需要自行声明类型或使用 `@types/tree-sitter`

### vscode-languageserver-protocol (v3.18.0) + vscode-jsonrpc (v9.0.0)

- **协议类型**: 从 `vscode-languageserver-protocol` 导入 `Diagnostic`, `Location`, `Position`, `Range`, `SymbolKind`, `InitializeParams`, `InitializeResult`, `TextDocumentItem`, `DidOpenTextDocumentParams`, `ReferenceContext` 等
- **LSP 客户端通信**: 使用 `vscode-jsonrpc/node` 的 `StreamMessageReader` / `StreamMessageWriter` + `createMessageConnection` 替代手写 Content-Length 帧解析。这是官方推荐的客户端模式，且 `vscode-jsonrpc@9.0.0` 已作为传递依赖存在
- **用法示例**: `import * as rpc from "vscode-jsonrpc/node"` → `rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin))` → `connection.sendRequest(method, params)` / `connection.onNotification(type, handler)`
- **不用 createConnection**: `createConnection` 是服务端 API（用于构建 language server），本项目是客户端，不需要

## Architecture

```
index.ts                    ← Pi extension entry, default export(pi: ExtensionAPI)
├── core/                   ← Pure analysis logic, no Pi dependency
│   ├── treesitter.ts       ← AST parsing + symbol extraction (18 languages)
│   ├── graph.ts            ← Symbol dependency graph (imports, calls, references)
│   ├── pagerank.ts         ← PageRank symbol importance scoring
│   ├── scanner.ts          ← Project file scanning + graph building
│   ├── encoding.ts         ← UTF-8 → GBK → GB2312 adaptive encoding
│   └── cache.ts            ← Graph baseline save/diff + persistent V2 graph cache
├── lsp/                    ← Language server process management
│   ├── manager.ts          ← Server lifecycle (spawn, stdio, health, shutdown)
│   ├── client.ts           ← LSP protocol communication (JSON-RPC over stdio via vscode-jsonrpc)
│   ├── servers.ts          ← Language→server config table (6 languages: Python, TypeScript, Go, JSON, YAML, Rust)
│   └── setup.ts            ← /shazam-setup command: detect + install guidance
├── tools/                  ← One file per registerTool call
│   ├── _context.ts         ← Tool-level shared LspManager holder (replaces core/lsp-global.ts)
│   ├── _factory.ts         ← createTool() registration factory (json/maxTokens, scanProject, envelope, truncation)
│   ├── lsp_enrich.ts       ← Tool-layer LSP enrichment wrappers (workspace/symbol, documentSymbol, semanticTokens, foldingRange) with 5s timeout + null fallback
│   ├── overview.ts         ← Scenario trigger: use first in unfamiliar projects (module map, routes)
│   ├── impact.ts           ← Prerequisite: required before editing 2+ files or shared modules
│   ├── codesearch.ts       ← Anti-pattern: use this instead of grep (BM25 ranking + LSP enrichment)
│   ├── file_detail.ts      ← Scenario trigger: shows structure not syntax before first edit
│   ├── call_chain.ts       ← Consequence hint: without this you ship bugs from missed callers
│   ├── symbol.ts           ← Scenario trigger: look up symbol before importing/calling (mode=state)
│   ├── verify.ts           ← Action binding: run after every write/edit (PASS/WARN/FAIL)
│   ├── fix.ts              ← Action binding: auto-fix format/lint when verify reports errors
│   ├── hotspots.ts         ← Consequence hint: without this you optimize the wrong files
│   ├── hover.ts            ← Action binding: get type signatures + docs after finding a symbol
│   ├── find_tests.ts       ← Scenario trigger: discover test files before adding/modifying tests
│   ├── type_hierarchy.ts   ← Scenario trigger: see inheritance chain for OOP/interface types
│   ├── rename_symbol.ts    ← Prerequisite: safety gate before renaming (verify references first)
│   └── safe_delete.ts      ← Prerequisite: safety gate before removing (verify zero refs first)
└── hooks/                  ← Automatic (not LLM-visible)
    ├── before-start.ts     ← Inject overview into system prompt
    └── after-write.ts      ← Auto verify + fix after write/edit
```

### Layer dependency direction

`hooks/` → `tools/` → `core/` + `lsp/`. The `core/` layer has zero Pi or LSP imports. Tools compose core functions and optionally enrich with LSP data. Hooks call tool logic directly and inject results into LLM context via `pi.sendMessage()`.

## Core Flows

- **Overview injection**: `before_agent_start` event → `core/treesitter` scan (with persistent disk cache) → `core/pagerank` → format summary → inject into `systemPrompt` array
- **Tool call**: LLM calls tool → `tools/*.execute()` → `core/scanner` (disk cache → in-memory cache → incremental/full scan) → `core/` analysis → optional LSP enrichment via `tools/lsp_enrich.ts` (5s timeout, tree-sitter fallback) → return `AgentToolResult`
- **Auto-verify**: `tool_call` event (write/edit) → `hooks/after-write` → `core/` diagnostics + LSP `textDocument/publishDiagnostics` → `pi.sendMessage()` with findings
- **LSP lifecycle**: extension load → `lsp/manager` detects project languages (6 supported: Python, TypeScript, Go, JSON, YAML, Rust) → spawns servers on demand → `lsp/client` handles JSON-RPC via vscode-jsonrpc over stdio → `session_shutdown` kills all

## API Surface

### LSP Methods on LspClient

`lsp/client.ts` exposes the following LSP protocol methods. Each returns `null` when the server is unavailable, the file is not opened, the server capability is missing, or the call times out (5s). Tools compose these via `tools/lsp_enrich.ts`.

| Method | LSP request | Consumer |
|--------|-------------|----------|
| `definition` | `textDocument/definition` | tools/symbol.ts (future), tools/type_hierarchy.ts |
| `references` | `textDocument/references` | tools/call_chain.ts, tools/verify.ts |
| `hover` | `textDocument/hover` | tools/hover.ts |
| `documentSymbols` | `textDocument/documentSymbol` | tools/symbol.ts, tools/file_detail.ts (via `lspDocumentSymbols`) |
| `workspaceSymbol` | `workspace/symbol` | tools/codesearch.ts (via `lspWorkspaceSearch`) |
| `semanticTokens` | `textDocument/semanticTokens/full` | (wired via `lspSemanticTokens`, not yet consumed by tools) |
| `foldingRange` | `textDocument/foldingRange` | (wired via `lspFoldingRanges`, not yet consumed by tools) |

> ⚠️ 契约文档：`CONTRACT.md` 为 Pi ExtensionAPI 真实契约的权威来源，提取自 `pi-coding-agent@0.78.1` 运行时源码。

### Registered Tools (LLM-visible)

| Tool | Style | Description |
|------|-------|-------------|
| `shazam_overview` | Scenario trigger | When you first enter a project — see the codebase structure before reading a single file |
| `shazam_impact` | Prerequisite | Required before editing 2+ files or any shared/exported module |
| `shazam_codesearch` | Anti-pattern | Don't reach for grep — this ranks results by relevance with BM25 |
| `shazam_symbol` | Scenario trigger | When you need to look up a symbol before importing or calling it |
| `shazam_hover` | Action binding | After finding a symbol, get its full type signature and documentation |
| `shazam_file_detail` | Scenario trigger | When about to edit an unfamiliar file — shows structure, not just syntax |
| `shazam_call_chain` | Consequence hint | Without this you ship bugs — traces ALL upstream callers and downstream callees |
| `shazam_verify` | Action binding | After every write or edit — confirm no errors (PASS/WARN/FAIL) |
| `shazam_find_tests` | Scenario trigger | When adding tests — discover test files and coverage for a module |
| `shazam_hotspots` | Consequence hint | Without this you optimize the wrong files — ranked by blast radius |
| `shazam_fix` | Action binding | When verify reports format/lint errors — auto-fix with nearest-wins formatters |
| `shazam_type_hierarchy` | Scenario trigger | When working with OOP types — see the full inheritance chain |
| `shazam_rename_symbol` | Prerequisite | Safety gate before renaming — verify references first, then rename |
| `shazam_safe_delete` | Prerequisite | Safety gate before removal — verify zero incoming references first |

All tools follow the same pattern:
- Parameters: TypeBox schema via direct `import { Type } from "typebox"`（不使用 `pi.typebox`——Pi 运行时不一定注入，参考 pi-smart-fetch 的做法）
- Output: `{ content: [{ type: "text", text: string }] }` — plain text for LLM reading
- Optional `{ json: true }` parameter for structured JSON output
- Write-operation tools support `{ dryRun: true }`

### Registered Commands

- `/shazam-setup` — detect installed language servers, output install instructions for missing ones
- `/shazam-doctor` — health check: verify tree-sitter grammars, LSP servers, cache integrity

### Output Envelope (JSON mode)

```json
{
  "schema_version": "1.0",
  "command": "<tool_name>",
  "project": "<absolute_path>",
  "status": "ok",
  "result": { }
}
```

## Change Map

- **Adding a new tool**: Create `tools/<name>.ts` with `register*` function using `createTool(pi, { name, label, description, params, execute })` from `tools/_factory.ts` → import and call in `index.ts` → the factory auto-handles json/maxTokens params, scanProject, content envelope, and truncation → for complex async tools, use `customExecute` instead of `execute` → append Next recommendation rules to `NEXT_RULES` in `core/output.ts` (no switch to edit) → choose one of 5 description styles: Prerequisite, Scenario trigger, Consequence hint, Action binding, or Anti-pattern warning → sync the tool table in `AGENTS.md` and add full docs to `SKILL.md`
- **Adding a Next recommendation**: Append a `NextRule` object to `NEXT_RULES` in `core/output.ts`. Each rule: `{ forTools, condition(ctx, graph?), recommendation(ctx) }`. Rules evaluate against context + optional RepoGraph (for graph-aware filters like `hasTestFiles`, `hasHierarchyKinds`).
- **Adding a new language**: Add grammar to `core/treesitter.ts` EXT_TO_LANG map → add tree-sitter query in queries section → add LSP server config in `lsp/servers.ts`
- **Changing graph algorithm**: Modify `core/pagerank.ts` or `core/graph.ts` → verify all tools that consume `RepoGraph` still produce correct output
- **Changing LSP protocol**: Modify `lsp/client.ts` → verify `lsp/manager.ts` lifecycle still works → test with at least 2 different language servers
- **Changing tool output format**: Update the specific `tools/*.ts` formatter → verify JSON envelope schema

## Release & Publish 流程

### 发布方式：GitHub Actions（强制）

**禁止直接 `npm publish`。** 本地 npm token 容易过期。发布统一通过 GitHub Actions workflow `.github/workflows/publish.yml`。

发布流程：
1. 开发完成、测试通过后，提交代码到分支
2. `npm version patch`（或 `minor`/`major`）→ 自动创建 git tag
3. `git push origin <branch> --tags`
4. 创建 PR → 合并到 main
5. 创建 GitHub Release（`gh release create vX.Y.Z`）
6. Release 发布事件自动触发 `.github/workflows/publish.yml`
   - 也可以手动触发：`gh workflow run publish.yml --ref main -f tag=latest`

### 发布 CI 做的事

`.github/workflows/publish.yml`：
- `npm ci --legacy-peer-deps`
- `npx tsc --noEmit`（类型检查）
- `npm test`（单元测试）
- `npm run build`（编译）
- `npm publish`（用 `secrets.NPM_TOKEN` 认证）
- 等待 15 秒后 `npm view pi-shazam` 验证

**NOTE**: `secrets.NPM_TOKEN` 是 GitHub 仓库秘密，在 Settings → Secrets and variables → Actions 中配置。值是 npm 的 Automation Token（无 2FA）。

### tool 参数 schema 注意事项

- **使用 `import { Type } from "typebox"`**，不要用 `pi.typebox`
  - Pi 运行时的 `ExtensionAPI.typebox` 不一定存在，`pi.typebox.Object()` 会导致 `Cannot read properties of undefined (reading 'Object')`
  - 其他 Pi 扩展（如 `pi-smart-fetch`）都是直接导入 `@sinclair/typebox` 或 `typebox`
- `typebox` 包版本固定在 `1.1.39`（`sinclairzx81` 的同名包）
- API：`Type.Object({...})`、`Type.Optional(...)`、`Type.String()`、`Type.Number()`、`Type.Boolean()`、`Type.Array(...)`

## Verification Matrix

### 每次修改后（强制）

| Step | Command | What it checks |
|------|---------|---------------|
| 1 | `npm run typecheck` | Type safety |
| 2 | `npm test` | 98 tests |
| 3 | `npm run build` | Compile output |

### 发布前契约检查（强制）

参考 `CONTRACT.md` 完整契约文档。

```
□ grep "pi\.logger\." dist/          # 不能有无保护的直接调用
□ grep "pi\.typebox" dist/           # 不能有引用
□ grep "content:" dist/index.js      # sendMessage: string 格式
□ grep "content:" dist/hooks/*.js    # sendMessage: string 格式
□ grep "content:" dist/tools/*.js    # Tool 返回: [{type:"text", text:...}]
□ grep "systemPrompt:" dist/hooks/   # 返回 string，非 Array
```

### 调试指南

- **扩展加载失败** → 检查 `CONTRACT.md`，对比运行时 API 版本
- **`text.replace is not a function`** → 检查 sendMessage content 是否 string
- **`Cannot read properties of undefined`** → 检查是否直接访问 pi.logger/pi.typebox/ctx.ui
- **工具不出现** → 检查 register* 是否在 index.ts 中调用

## First Places to Inspect

- `index.ts` — extension entry, all registrations
- `core/treesitter.ts` — language support, symbol extraction entry
- `core/graph.ts` — how symbols become a dependency graph
- `core/scanner.ts` — project scanning + graph building
- `lsp/client.ts` — LSP JSON-RPC implementation
- `tools/_factory.ts` — createTool() factory: eliminates per-tool boilerplate
- `tools/overview.ts` — representative tool using the factory (others follow same shape)
- `hooks/before-start.ts` — system prompt injection pattern

## Key Directories

- `core/` — Pure analysis, no external I/O beyond filesystem reads
- `lsp/` — External process management (language servers)
- `tools/` — Pi tool registration wrappers (one file per tool)
- `hooks/` — Automatic event handlers (not LLM-callable)

## Important Files

- `index.ts` — extension entry point and registration coordinator
- `SKILL.md` — Pi agent skill file documenting all 16 tools for LLM discovery
- `package.json` — npm manifest, dependencies, build scripts
- `tsconfig.json` — TypeScript compiler configuration
- `types/pi-extension.d.ts` — self-contained ExtensionAPI type stub (source of truth for Pi API types)

<general-project-rules>

# General Project Rules

## Coding Rules

- Layer boundaries: `core/` must not import from `tools/`, `hooks/`, or `lsp/`. Tools compose core; hooks compose tools.
- Tool registration: Every tool file exports a `register*(pi: ExtensionAPI)` function. The registration happens in `index.ts` default export.
- Output format: All tools return plain text by default, structured JSON when `{ json: true }` is passed. Never mix formats.
- LSP degradation: When LSP server is unavailable, fall back to tree-sitter only. Annotate output with "(tree-sitter only, LSP unavailable)". Never throw on missing LSP.
- Encoding: Always use `core/encoding.ts` adaptive reader (UTF-8 → GBK → GB2312). Never assume UTF-8 for source files.
- Tool descriptions: Write clear, specific `description` strings for every registered tool — these are what the LLM reads to decide when to call.
- CI: Invoke `github-workflow` skill before the first code commit. CI must exist on day 1.
- PRs: One vertical slice per PR — build a complete module (core + tool + typecheck), then merge. No big-bang PRs.
- TDD: Write the test first for every slice. Watch it fail, implement, verify, commit.
- CLAUDE.md: Update this file whenever a new module, tool, command, or data flow is created.

## Testing Rules

- Type correctness: Run `npm run typecheck` after every change. This is the minimum verification gate.
- Integration testing: Symlink `dist/` into Pi extensions directory and verify tool calls in a live Pi session.
- Test repos: Use `~/.A1/repomap` itself as a test target — it has Python + tree-sitter + LSP scenarios.

## Debugging Rules

- Tree-sitter parse failures: Check grammar version compatibility in `package.json`. Run parse on a single file with verbose logging.
- LSP communication errors: Check `lsp/client.ts` JSON-RPC frame parsing. Common issues: Content-Length mismatch, incomplete reads, server crash on initialize.
- Tool not appearing in Pi: Verify `register*` is called in `index.ts`. Check Pi extension loading logs. Verify the tool name doesn't conflict with existing Pi tools.

## Verification Before Completion

- Every module: `npm run typecheck` passes with zero errors.
- Every tool: callable from Pi, returns non-empty text output on a sample project.
- Every hook: triggers correctly on the appropriate event in a live Pi session.
- Every LSP feature: at least one language server responds correctly to the relevant LSP method.

## Project-Specific Rules

- **Language: English only.** All source code, code comments, JSDoc, commit messages, PR titles/descriptions, GitHub Issue content, and GitHub Release notes MUST be written in English. No Chinese or any other non-English language in any artifact that goes into the repository.
- **No emoji or decorative symbols.** Emoji (✅❌🔴🟡🟢🆕⚠️💡 etc.), Unicode decorative characters, and ASCII art are forbidden in all source files, tool output, code comments, and commit messages. The only allowed symbols are standard ASCII punctuation and Markdown formatting characters. This rule applies to all repository artifacts except `AGENTS.md` itself (this file) and `SKILL.md`.
- **Tool output must be clean.** Tool output text returned to the LLM must be minimal, structured, and free of noise. Specifically:
  - No emoji, no decorative Unicode, no ANSI escape codes
  - No "friendly" filler phrases — be direct and factual
  - Consistent heading hierarchy (`## tool_name`, `### section`)
  - Numerical data in tables or key-value pairs, not prose
  - Truncation explicitly flagged (`... and N more`)
  - No trailing whitespace, no excessive blank lines
- Pi extension API: Import types from `./types/pi-extension.js` (local stub). Use `ExtensionAPI`, `ExtensionContext`, `AgentToolResult` — do not redefine these types.
- Tool naming: Prefix all tools with `shazam_` to avoid conflicts with other Pi extensions.
- Symbol IDs: Format as `{file}::{name}::{line}` to match the repomap convention. Keep this stable — other tools depend on it.

</general-project-rules>
