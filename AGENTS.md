# pi-shazam

> **IMPORTANT: LANGUAGE RULE**
>
> **All source code, code comments, JSDoc, commit messages, PR titles/descriptions,
> GitHub Issue content, and GitHub Release notes MUST be written in English.**
>
> No Chinese or any other non-English language in any artifact that goes into the repository.
> This is a hard requirement for this project.

> **DEVELOPMENT RULE: All development and maintenance of this project MUST follow
> the conventions, workflows, and contracts defined in [INSTRUCTION.md](./docs/INSTRUCTION.md).
> This includes Pi extension API contracts, architecture layer boundaries, tool
> registration patterns, content format contracts, release process, and verification
> gates. INSTRUCTION.md is the single source of truth for how to build and maintain
> pi-shazam. Read it before making any change.**

Pi coding agent native codebase awareness extension. "Shazam" — like the superhero whose power comes from multiple deities, pi-shazam unifies the strength of multiple analysis engines (repomap/aider, pi-lens, serena MCP, tree-sitter, LSP) into one coherent interface for the agent.

Rewrites the Python CLI project [repomap](https://github.com/gjczone/repomap) as a native Pi extension in TypeScript. All analysis capabilities register as first-class Pi tools — LLM sees them alongside `read`/`write`/`bash` with no distinction.

## Project Snapshot

- **Runtime**: TypeScript on Node.js ≥18, ES2022 target, NodeNext module resolution, ESM (`"type": "module"`)
- **Package**: npm `pi-shazam`, entry `dist/index.js` (default export function receiving `ExtensionAPI`)
- **Primary user flow**: LLM calls analysis tools (`overview`, `impact`, `codesearch`, etc.) to understand code structure, change impact, and call chains before making edits
- **Architecture**: 4 layers — `core/` (parsing, graph, ranking), `lsp/` (language server management), `tools/` (Pi tool wrappers), `hooks/` (automatic verification)
- **External dependency**: Language servers (pyright, tsserver, rust-analyzer, gopls) are user-installed; pi-shazam manages process lifecycle
- **Release artifact**: npm package with `dist/` compiled output

## Current Version

**0.8.0** — synced across all surfaces:

| Surface                     | Version | Check                                                      |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `package.json`              | 0.8.0   | `node -e "console.log(require('./package.json').version)"` |
| MCP server (`mcp/entry.ts`) | 0.8.0   | `grep version mcp/entry.ts`                                |
| Global npm install          | 0.8.0   | `npm ls -g pi-shazam`                                      |
| GitHub Release              | v0.8.0  | `gh release view v0.8.0`                                   |
| Git tag                     | v0.8.0  | `git describe --tags`                                      |
| npm registry                | 0.8.0   | `npm view pi-shazam version`                               |

## Commands

| Command                          | Purpose                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm install --legacy-peer-deps` | Install dependencies (legacy-peer-deps required for tree-sitter)                                 |
| `npm run build`                  | Compile TS → `dist/`                                                                             |
| `npm run typecheck`              | `tsc --noEmit` — type validation without emit                                                    |
| `npm run dev`                    | `tsc --watch` — incremental compilation                                                          |
| `npm publish`                    | **DO NOT use directly** — Publishing is done via GitHub Actions (see Release & Publish workflow) |

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
- **No QueryCursor**: Node.js binding does not have Python's `QueryCursor` class, use `query.captures()` directly
- **Node properties**: `node.type`, `node.text`, `node.children`, `node.parent`, `node.previousSibling`, `node.startPosition`/`endPosition` (`.row`/`.column`), `node.childForFieldName("name")`
- **Grammar loading**: `new Language(grammarModule)` wraps native module, not Python's `Language(fn())` constructor pattern
- **Input type**: `parse()` accepts `string` or callback `(index, position) => string | null`, not Buffer
- **No built-in .d.ts**: Need to declare types manually or use `@types/tree-sitter`

### vscode-languageserver-protocol (v3.18.0) + vscode-jsonrpc (v9.0.0)

- **Protocol types**: Import `Diagnostic`, `Location`, `Position`, `Range`, `SymbolKind`, `InitializeParams`, `InitializeResult`, `TextDocumentItem`, `DidOpenTextDocumentParams`, `ReferenceContext` etc. from `vscode-languageserver-protocol`
- **LSP client communication**: Use `vscode-jsonrpc/node`'s `StreamMessageReader` / `StreamMessageWriter` + `createMessageConnection` instead of hand-written Content-Length frame parsing. This is the officially recommended client pattern, and `vscode-jsonrpc@9.0.0` is already a transitive dependency
- **Usage example**: `import * as rpc from "vscode-jsonrpc/node"` → `rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout), new rpc.StreamMessageWriter(child.stdin))` → `connection.sendRequest(method, params)` / `connection.onNotification(type, handler)`
- **Do not use createConnection**: `createConnection` is a server-side API (for building language servers), this project is a client and does not need it

## Architecture

```
index.ts                    ← Pi extension entry, default export(pi: ExtensionAPI)
├── core/                   ← Pure analysis logic, no Pi dependency
│   ├── treesitter.ts       ← AST parsing + symbol extraction (5 languages)
│   ├── treesitter-queries.ts ← Tree-sitter query patterns for all languages
│   ├── graph.ts            ← Symbol dependency graph (imports, calls, references)
│   ├── pagerank.ts         ← PageRank symbol importance scoring
│   ├── scanner.ts          ← Project file scanning + graph building
│   ├── encoding.ts         ← UTF-8 → GBK → GB2312 adaptive encoding
│   ├── cache.ts            ← Graph baseline save/diff + persistent V2 graph cache
│   ├── baseline.ts         ← In-memory session baseline for diff-aware verify
│   ├── filter.ts           ← Shared file filtering (source vs config/generated)
│   ├── output.ts           ← Standardized tool output formatting + Next rules
│   └── git-hooks.ts        ← Git pre-commit hook install/remove/verify
├── lsp/                    ← Language server process management
│   ├── manager.ts          ← Server lifecycle (spawn, stdio, health, shutdown)
│   ├── client.ts           ← LSP protocol communication (JSON-RPC over stdio via vscode-jsonrpc)
│   ├── servers.ts          ← Language→server config table (6 languages: Python, TypeScript, Go, JSON, YAML, Rust)
│   └── setup.ts            ← /shazam-setup command: detect + install guidance
├── tools/                  ← One file per registerTool call
│   ├── _context.ts         ← Tool-level shared LspManager holder (replaces core/lsp-global.ts)
│   ├── _factory.ts         ← createTool() registration factory (json/maxTokens, scanProject, envelope, truncation)
│   ├── definitions.ts      ← Shared tool definitions (names, descriptions, param schemas)
│   ├── lsp_enrich.ts       ← Tool-layer LSP enrichment wrappers (workspace/symbol, documentSymbol, semanticTokens, foldingRange) with 5s timeout + null fallback
│   ├── overview.ts         ← Scenario trigger: use first in unfamiliar projects (module map, deps, git history, routes)
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
    ├── safety.ts           ← Destructive command confirmation + pre-commit gate
    ├── pre-edit.ts         ← Pre-edit guard: detect multi-file edits, suggest shazam_impact
    ├── shazam-guide.ts     ← Auto-format + contextual tool suggestions
    ├── stop-verify.ts      ← Remind to verify before ending turn
    ├── failure-recovery.ts ← Detect consecutive failures, suggest alternatives
    └── tool-logger.ts      ← Log shazam calls to ~/.pi/hooks/audit/shazam-calls.log
mcp/                        ← MCP server for non-Pi clients
├── entry.ts                ← McpServer + StdioServerTransport init
├── tools.ts                ← 14 MCP tool registrations wrapping core
└── README.md               ← Client setup guide (Cursor, Claude Desktop, etc.)
```

### Layer dependency direction

`hooks/` → `tools/` → `core/` + `lsp/`. The `core/` layer has zero Pi or LSP imports. Tools compose core functions and optionally enrich with LSP data. Hooks call tool logic directly and inject results into LLM context via `pi.sendMessage()`.

## Hooks (Automatic Event Handlers)

| Hook               | Event                       | Auto? | Effect                                                                  | Value                                                   |
| ------------------ | --------------------------- | ----- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `before-start`     | `before_agent_start`        | YES   | Injects project overview + proactive recommendations into system prompt | HIGH — LLM has structural awareness before reading code |
| `safety`           | `tool_call` (bash)          | YES   | Destructive command confirmation + pre-commit gate                      | HIGH — prevents data loss and unverified commits        |
| `pre-edit`         | `tool_call` (write/edit)    | YES   | Detects multi-file edits, warns about blast radius                      | MEDIUM — prevents accidental multi-file breaks          |
| `shazam-guide`     | `tool_result`               | YES   | Auto-format + suggests related shazam tools                             | HIGH — auto-formats code, helps LLM discover tools      |
| `stop-verify`      | `turn_end`                  | YES   | Reminds to verify before ending turn                                    | HIGH — prevents unverified edits                        |
| `failure-recovery` | `tool_result`               | YES   | Detects consecutive failures, suggests alternatives                     | MEDIUM — prevents LLM loops                             |
| `tool-logger`      | `tool_call` + `tool_result` | YES   | Logs all shazam tool calls to JSONL file                                | LOW — debugging only, no LLM impact                     |

### Hook Details

**before-start** (HIGH value):

- Runs on `before_agent_start` event
- Scans project with tree-sitter (cached)
- Generates overview: module map, key files, git history
- Injects proactive recommendations based on project state
- Creates session baseline for diff-aware verify
- Effect: LLM starts with full project awareness

**safety** (HIGH value):

- Runs on `tool_call` for bash commands
- Destructive command detection: shows interactive confirmation dialog for dangerous commands (rm -rf, dd, mkfs, etc.)
- Pre-commit gate: blocks git commit if shazam_verify was not run recently
- Uses Pi's `ctx.ui.confirm()` and `ctx.ui.select()` for user interaction
- Effect: Prevents data loss and unverified commits

**pre-edit** (MEDIUM value):

- Runs on `tool_call` for write/edit
- Tracks files edited in session
- Warns when editing multiple files or shared modules
- Effect: Prevents accidental multi-file breaks

**shazam-guide** (HIGH value):

- Runs on `tool_result`
- Auto-format: detects file type and runs native formatter (ruff, prettier, gofmt, rustfmt)
- Falls back to suggesting `shazam_fix` if no native formatter found
- Suggests related tools based on context:
  - After symbol lookup → suggest `shazam_call_chain`
  - After grep/find → suggest `shazam_codesearch`
- Effect: Auto-formats code, helps LLM discover the right tool

**stop-verify** (HIGH value):

- Runs on `turn_end` event
- Checks if there were unverified file edits
- Sends reminder to run `shazam_verify` before ending turn
- Effect: Prevents unverified edits from being committed

**failure-recovery** (MEDIUM value):

- Runs on `tool_result` with `isError` flag
- Tracks consecutive failures per tool
- After 3 failures: suggests alternative approaches
- After 5 failures: suggests reorienting with `shazam_overview`
- Effect: Prevents LLM loops where it keeps trying the same failing approach

**tool-logger** (LOW value):

- Runs on `tool_call` + `tool_result`
- Logs to `~/.pi/hooks/audit/shazam-calls.log`
- JSONL format with timestamps, duration, result
- Effect: Debugging only, no impact on LLM

## Tools (LLM-Callable)

### High Value Tools

| Tool                | Value | When to Use                         | Auto-called?                |
| ------------------- | ----- | ----------------------------------- | --------------------------- |
| `shazam_overview`   | HIGH  | First time in project               | YES (via before-start hook) |
| `shazam_verify`     | HIGH  | After every edit                    | NO (LLM calls manually)     |
| `shazam_impact`     | HIGH  | Before editing 2+ files             | NO (LLM calls manually)     |
| `shazam_call_chain` | HIGH  | Before changing function signature  | NO (LLM calls manually)     |
| `shazam_codesearch` | HIGH  | Instead of grep                     | NO (LLM calls manually)     |
| `shazam_hover`      | HIGH  | After finding symbol, get type info | NO (LLM calls manually)     |

### Medium Value Tools

| Tool                    | Value  | When to Use                     | Auto-called? |
| ----------------------- | ------ | ------------------------------- | ------------ |
| `shazam_symbol`         | MEDIUM | Look up symbol before importing | NO           |
| `shazam_file_detail`    | MEDIUM | Before editing unfamiliar file  | NO           |
| `shazam_find_tests`     | MEDIUM | When adding tests               | NO           |
| `shazam_type_hierarchy` | MEDIUM | For OOP/interface types         | NO           |
| `shazam_hotspots`       | MEDIUM | Find high-risk files            | NO           |
| `shazam_fix`            | MEDIUM | Auto-fix format/lint errors     | NO           |

### Low Value Tools

| Tool                   | Value | Why                                           |
| ---------------------- | ----- | --------------------------------------------- |
| `shazam_rename_symbol` | LOW   | Rarely used, LLM can use IDE or manual rename |
| `shazam_safe_delete`   | LOW   | Rarely used, LLM can delete manually          |

## Core Flows

- **Overview injection**: `before_agent_start` event → `core/treesitter` scan (with persistent disk cache) → `core/pagerank` → format summary → inject into `systemPrompt` array
- **Tool call**: LLM calls tool → `tools/*.execute()` → `core/scanner` (disk cache → in-memory cache → incremental/full scan) → `core/` analysis → optional LSP enrichment via `tools/lsp_enrich.ts` (5s timeout, tree-sitter fallback) → return `AgentToolResult`
- **Verification**: LLM calls `shazam_verify` manually when needed (no automatic verification after edits).
- **Tool logging**: `tool_call` + `tool_result` events → `hooks/tool-logger` → writes JSONL to `~/.pi/hooks/audit/shazam-calls.log`
- **Agent guidance**: `before_agent_start` → `hooks/shazam-guide` → injects tool list into system prompt; `tool_result` (write/edit) → nudges `shazam_verify`; `tool_call` (grep/find) → nudges `shazam_codesearch`
- **MCP tool calls**: MCP client → JSON-RPC over stdio → `mcp/tools.ts` → `core/` analysis → return `{ content: [...] }`
- **LSP lifecycle**: extension load → `lsp/manager` detects project languages → spawns servers on demand → `lsp/client` handles JSON-RPC via vscode-jsonrpc over stdio → `session_shutdown` kills all

## API Surface

### LSP Methods on LspClient

`lsp/client.ts` exposes the following LSP protocol methods. Each returns `null` when the server is unavailable, the file is not opened, the server capability is missing, or the call times out (5s). Tools compose these via `tools/lsp_enrich.ts`.

| Method            | LSP request                        | Consumer                                                         |
| ----------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `definition`      | `textDocument/definition`          | tools/symbol.ts (future), tools/type_hierarchy.ts                |
| `references`      | `textDocument/references`          | tools/call_chain.ts, tools/verify.ts                             |
| `hover`           | `textDocument/hover`               | tools/hover.ts                                                   |
| `documentSymbols` | `textDocument/documentSymbol`      | tools/symbol.ts, tools/file_detail.ts (via `lspDocumentSymbols`) |
| `workspaceSymbol` | `workspace/symbol`                 | tools/codesearch.ts (via `lspWorkspaceSearch`)                   |
| `semanticTokens`  | `textDocument/semanticTokens/full` | (wired via `lspSemanticTokens`, not yet consumed by tools)       |
| `foldingRange`    | `textDocument/foldingRange`        | (wired via `lspFoldingRanges`, not yet consumed by tools)        |

> Contract documentation: `docs/INSTRUCTION.md` §1 is the authoritative source for Pi ExtensionAPI real contract, extracted from `pi-coding-agent@0.78.1` runtime source.

### Registered Tools (LLM-visible)

| Tool                    | Style            | Description                                                                                    |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `shazam_overview`       | Scenario trigger | When you first enter a project — see structure, deps, git history before reading a single file |
| `shazam_impact`         | Prerequisite     | Required before editing 2+ files or any shared/exported module                                 |
| `shazam_codesearch`     | Anti-pattern     | Don't reach for grep — this ranks results by relevance with BM25                               |
| `shazam_symbol`         | Scenario trigger | When you need to look up a symbol before importing or calling it                               |
| `shazam_hover`          | Action binding   | After finding a symbol, get its full type signature and documentation                          |
| `shazam_file_detail`    | Scenario trigger | When about to edit an unfamiliar file — shows structure, not just syntax                       |
| `shazam_call_chain`     | Consequence hint | Without this you ship bugs — traces ALL upstream callers and downstream callees                |
| `shazam_verify`         | Action binding   | After every write or edit — confirm no errors (PASS/WARN/FAIL)                                 |
| `shazam_find_tests`     | Scenario trigger | When adding tests — discover test files and coverage for a module                              |
| `shazam_hotspots`       | Consequence hint | Without this you optimize the wrong files — ranked by blast radius                             |
| `shazam_fix`            | Action binding   | When verify reports format/lint errors — auto-fix with nearest-wins formatters                 |
| `shazam_type_hierarchy` | Scenario trigger | When working with OOP types — see the full inheritance chain                                   |
| `shazam_rename_symbol`  | Prerequisite     | Safety gate before renaming — verify references first, then rename                             |
| `shazam_safe_delete`    | Prerequisite     | Safety gate before removal — verify zero incoming references first                             |

All tools follow the same pattern:

- Parameters: TypeBox schema via direct `import { Type } from "typebox"`(Do not use `pi.typebox` — Pi runtime may not inject it, see pi-smart-fetch for reference)
- Output: `{ content: [{ type: "text", text: string }] }` — plain text for LLM reading
- Optional `{ json: true }` parameter for structured JSON output
- Write-operation tools support `{ dryRun: true }`

### Registered Commands

- `/shazam-setup` — detect installed language servers, output install instructions for missing ones
- `/shazam-doctor` — health check: verify tree-sitter grammars, LSP servers, cache integrity
- `/shazam-install-git-hooks` — install git pre-commit hook that runs shazam_verify --preCommit
- `/shazam-remove-git-hooks` — remove the shazam git pre-commit hook and restore original
- `/shazam-pre-commit-verify` — run pre-commit verification (used by the git hook script)

### Output Envelope (JSON mode)

```json
{
	"schema_version": "1.0",
	"command": "<tool_name>",
	"project": "<absolute_path>",
	"status": "ok",
	"result": {}
}
```

## Change Map

- **Adding a new tool**: Create `tools/<name>.ts` with `register*` function using `createTool(pi, { name, label, description, params, execute })` from `tools/_factory.ts` → import and call in `index.ts` → the factory auto-handles json/maxTokens params, scanProject, content envelope, and truncation → for complex async tools, use `customExecute` instead of `execute` → append Next recommendation rules to `NEXT_RULES` in `core/output.ts` (no switch to edit) → choose one of 5 description styles: Prerequisite, Scenario trigger, Consequence hint, Action binding, or Anti-pattern warning → sync the tool table in `AGENTS.md`, add full docs to `SKILL.md`, and update `README.md` if user-facing tool list changed
- **Adding a Next recommendation**: Append a `NextRule` object to `NEXT_RULES` in `core/output.ts`. Each rule: `{ forTools, condition(ctx, graph?), recommendation(ctx) }`. Rules evaluate against context + optional RepoGraph (for graph-aware filters like `hasTestFiles`, `hasHierarchyKinds`).
- **Adding a new language**: Add grammar to `core/treesitter.ts` EXT_TO_LANG map → add tree-sitter query in `core/treesitter-queries.ts` → add LSP server config in `lsp/servers.ts`
- **Changing graph algorithm**: Modify `core/pagerank.ts` or `core/graph.ts` → verify all tools that consume `RepoGraph` still produce correct output
- **Changing LSP protocol**: Modify `lsp/client.ts` → verify `lsp/manager.ts` lifecycle still works → test with at least 2 different language servers
- **Changing tool output format**: Update the specific `tools/*.ts` formatter → verify JSON envelope schema
- **Adding a new hook**: Create `hooks/<name>.ts` with a `register*` function that calls `pi.on(...)` → import and call in `index.ts` default export. Hooks subscribe to lifecycle events (`tool_execution_start`, `before_agent_start`, etc.) and do not return tools to the LLM. Add to hooks/ tree in `AGENTS.md`.
- **Adding a tool (MCP sync) [CRITICAL]**: After adding/changing/deleting a Pi tool → add/update/remove the matching `registerTool` in `mcp/tools.ts` → update `mcp/README.md` tool table → sync Pi tool description changes to MCP tool descriptions. MCP and Pi tools MUST stay in sync in the same PR. **Important**: MCP tools have SEPARATE definitions (using Zod) from Pi tools (using TypeBox). When changing:
  - Tool name: update `server.registerTool("shazam_*", ...)` in mcp/tools.ts
  - Tool description: update `description: "..."` in mcp/tools.ts
  - Tool parameters: update `inputSchema: z.object({...})` in mcp/tools.ts
  - Update `README.md` if user-facing tool list or usage changed
  - Run `./scripts/release.sh` to ensure everything is synced and deployed

## Issue Fix Workflow (Task Flow)

When fixing open issues, follow this workflow **without exception**. Pushing directly
to `main` is forbidden — every fix goes through a PR.

### Step-by-Step

```bash
# 1. Start from a clean main
git checkout main
git pull origin main

# 2. Create a feature branch named after the issues being fixed
git checkout -b fix/issue-<NUM>   # single issue
git checkout -b fix/issue-<A>-<B> # multiple related issues

# 3. Implement the fix (edit files, write tests, verify locally)
npm run typecheck
npm test
npm run build

# 4. Commit with referencing issue numbers in the message
git add -A
git commit -m "fix(#<A>,#<B>): concise description of the fix"

# 5. Push the branch
git push origin fix/issue-<NUM>

# 6. Create a PR
gh pr create \
  --title "fix(#<A>,#<B>): concise description" \
  --body "Closes #<A>, closes #<B>.

## Problem
...

## Fix
...

## Verification
- [ ] typecheck passes
- [ ] tests pass
- [ ] build succeeds" \
  --base main

# 7. Wait for CI to pass on the PR
#    - typecheck job must be green
#    - test job must be green (ubuntu + macos)
#    - build job must be green
#    - security job must be green
gh pr checks fix/issue-<NUM>

# 8. Once CI is green, merge the PR
gh pr merge fix/issue-<NUM> --squash --delete-branch

# 9. Close the issues (if not auto-closed by the PR merge)
gh issue close <NUM> -r completed -c "Fixed in PR #<PR_NUM>."
```

### Branch Naming Convention

| Pattern             | Usage                                |
| ------------------- | ------------------------------------ |
| `fix/issue-<NUM>`   | Single issue fix                     |
| `fix/issue-<A>-<B>` | Multiple related issues (2-5 issues) |
| `feat/<name>`       | New feature                          |
| `refactor/<name>`   | Refactoring                          |
| `docs/<name>`       | Documentation only                   |

### Commit Message Convention

```
fix(#<A>,#<B>): concise description

Optional detailed body explaining the fix.
```

- Reference all fixed issues in the subject line with `fix(#NNN)`.
- Use `fix:`, `feat:`, `refactor:`, `docs:` prefixes.
- Keep the subject line under 72 characters when possible.

### CI Checks (ci.yml)

The CI workflow runs on both `push` to `main` and `pull_request` to `main`.
Do NOT merge until all jobs pass:

| Job         | What It Checks                               |
| ----------- | -------------------------------------------- |
| `typecheck` | `npx tsc --noEmit` — zero type errors        |
| `test`      | `npm test` — all tests pass (ubuntu + macos) |
| `build`     | `npm run build` — `dist/` output exists      |
| `security`  | `npm audit --omit=dev` — informational       |

### Anti-Patterns

- **NEVER push directly to `main`**. Always use a feature branch + PR.
- **NEVER skip CI**. Wait for all checks to pass before merging.
- **NEVER leave stale branches**. Use `--delete-branch` when merging or clean up
  with `git push origin --delete <branch>` afterward.
- **NEVER close issues before the PR is merged**. Close issues after merge.

### Post-Merge Cleanup

```bash
# Switch back to main and pull the merge commit
git checkout main
git pull origin main

# Delete the local branch (remote already deleted by --delete-branch)
git branch -d fix/issue-<NUM>
```

## Release & Publish Workflow

### Release Notes & Changelog Requirements

**Every release MUST have detailed release notes and a CHANGELOG.md entry.** This is non-negotiable.

#### GitHub Release Notes

After creating a release, update the release notes with:

1. **What's Changed** section with subsections:
   - Features & Enhancements
   - Bug Fixes
   - Refactoring
   - Other
2. Each item should include:
   - Issue/PR number (e.g., `#199`)
   - Brief description of the change
   - Bullet points for specific details
3. **Upgrade** section with installation commands
4. **Full Changelog** link

Example:

````markdown
# v0.6.0

## What's Changed

### Features & Enhancements

- **enhance(#199): shazam_impact output now includes symbol-level detail** (#207)
  - Added risk assessment based on affected file and symbol counts
  - Added symbol grouping by file with upstream/downstream direction

### Bug Fixes

- **fix(#196,#200): find_tests sourceFile parameter now searches tests/ directory** (#204)
  - Fixed sourceFile parameter to search project-root test directories

## Upgrade

```bash
npm install -g pi-shazam@latest --legacy-peer-deps
pi install npm:pi-shazam@latest
```
````

**Full Changelog**: https://github.com/gjczone/pi-shazam/compare/v0.5.5...v0.6.0

````

#### CHANGELOG.md

Maintain a `CHANGELOG.md` file in the project root following [Keep a Changelog](https://keepachangelog.com/) format:

1. Each version gets a `## [X.Y.Z] - YYYY-MM-DD` section
2. Same subsections as release notes (Features, Bug Fixes, Refactoring, Other)
3. Include issue/PR numbers for traceability
4. Keep entries concise but informative

#### Release Script Integration

The release script (`scripts/release.sh`) creates a minimal release. After running it:

1. Edit the GitHub Release to add detailed notes
2. Update CHANGELOG.md with the same information
3. Commit CHANGELOG.md changes

### Quick Release (Recommended)

Use the automated release script:

```bash
./scripts/release.sh patch  # or minor, major
````

This script handles everything:

1. Bumps version in package.json
2. Syncs version to all surfaces (mcp/entry.ts, AGENTS.md, docs/INSTRUCTION.md)
3. Builds and tests
4. Commits and tags
5. Pushes to GitHub
6. Creates GitHub Release (triggers npm publish)
7. Updates local Pi extension (`pi update`)
8. Updates global npm install
9. Verifies all installations

**After running the release script, you MUST (non-negotiable, never skip):**

> ⚠️ **A release without CHANGELOG.md is an INCOMPLETE release.** The release script
> does NOT update CHANGELOG.md — this is a manual step that MUST happen every time.
> If you run `release.sh` and forget CHANGELOG.md, go back and fix it immediately.

1. Update the GitHub Release with detailed notes (see above)
2. Update `CHANGELOG.md` with the same information — use the format `[X.Y.Z] - YYYY-MM-DD`
   with subsections: Features & Enhancements, Bug Fixes, Refactoring, Other
3. Commit and push CHANGELOG.md changes

**Checklist before declaring release done:**

- [ ] GitHub Release has detailed notes (not just "See CHANGELOG")
- [ ] `CHANGELOG.md` has a `[X.Y.Z]` entry with all changes listed
- [ ] `CHANGELOG.md` changes committed and pushed

### Manual Publishing (If Needed)

**DO NOT use `npm publish` directly.** Local npm tokens expire easily. Publishing is done via GitHub Actions workflow `.github/workflows/publish.yml`.

Manual workflow:

1. After development is complete and tests pass, commit code to branch
2. `npm version patch` (or `minor`/`major`) → automatically creates git tag
3. Sync version to mcp/entry.ts, AGENTS.md, docs/INSTRUCTION.md
4. `git push origin <branch> --tags`
5. Create GitHub Release (`gh release create vX.Y.Z`)
6. Release publish event automatically triggers `.github/workflows/publish.yml`
7. After npm publish, run:
   ```bash
   npm install -g pi-shazam@latest --legacy-peer-deps
   pi update
   ```

### What the Publish CI Does

`.github/workflows/publish.yml`：

- `npm ci --legacy-peer-deps`
- `npx tsc --noEmit` (type checking)
- `npm test` (unit tests)
- `npm run build` (compile)
- `npm publish` (authenticated with `secrets.NPM_TOKEN`)
- Wait 15 seconds then verify with `npm view pi-shazam`

**NOTE**: `secrets.NPM_TOKEN` is a GitHub repository secret, configured in Settings → Secrets and variables → Actions. The value is an npm Automation Token (no 2FA).

### Tool Parameter Schema Notes

- **Use `import { Type } from "typebox"`**, do not use `pi.typebox`
  - Pi runtime's `ExtensionAPI.typebox` may not exist, `pi.typebox.Object()` will cause `Cannot read properties of undefined (reading 'Object')`
  - Other Pi extensions (like `pi-smart-fetch`) import `@sinclair/typebox` or `typebox` directly
- `typebox` package version is pinned at `1.1.39` (`sinclairzx81`'s package of the same name)
- API: `Type.Object({...})`, `Type.Optional(...)`, `Type.String()`, `Type.Number()`, `Type.Boolean()`, `Type.Array(...)`

## Verification Matrix

### After Every Change (Mandatory)

| Step | Command                                | What it checks            |
| ---- | -------------------------------------- | ------------------------- |
| 1    | `npm run typecheck`                    | Type safety               |
| 2    | `npm test`                             | 224 tests                 |
| 3    | `npm run build`                        | Compile output            |
| 4    | `pi -p "call shazam_overview briefly"` | Pi integration smoke test |

### Pi Integration Testing

```bash
# Install into Pi
pi install npm:pi-shazam@latest     # from npm
# OR copy local build:
cp dist/**/*.js ~/.pi/agent/npm/node_modules/pi-shazam/dist/ -r

# Smoke test all tools
pi -p "call shazam_overview briefly"
pi -p "call shazam_verify"
pi -p "call shazam_hotspots"

# Check: no "Extension error" in output, tools return meaningful results.
```

### MCP Testing

```bash
printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shazam_hotspots","arguments":{}}}\n' | timeout 15 node dist/mcp/entry.js . 2>/dev/null | tail -1
```

### Hook Verification

```bash
# Verify all hooks registered in built dist
grep -c "registerShazamGuide\|registerToolLogger\|registerBeforeStart\|registerAfterWrite" dist/index.js
# Should output: 4

# Verify system prompt injection works (no crash)
pi -p "call shazam_overview" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

### Pre-Publish Contract Check (Mandatory)

Refer to `docs/INSTRUCTION.md` §1 for the complete contract documentation.

```
□ grep "pi\.logger\." dist/          # No unprotected direct calls
□ grep "pi\.typebox" dist/           # No references
□ grep "content:" dist/index.js      # sendMessage: string format
□ grep "content:" dist/hooks/*.js    # sendMessage: string format
□ grep "content:" dist/tools/*.js    # Tool returns: [{type:"text", text:...}]
□ grep "systemPrompt:" dist/hooks/   # Returns string, not Array
```

### Debugging Guide

- **Extension load failure** → Check `docs/INSTRUCTION.md` §1, compare with runtime API version
- **`text.replace is not a function`** → Check if sendMessage content is string
- **`Cannot read properties of undefined`** → Check if directly accessing pi.logger/pi.typebox/ctx.ui
- **Tool not appearing** → Check if register\* is called in index.ts

## First Places to Inspect

- `index.ts` — extension entry, all registrations
- `core/treesitter.ts` — language support, symbol extraction entry
- `core/graph.ts` — how symbols become a dependency graph
- `core/scanner.ts` — project scanning + graph building
- `core/output.ts` — standardized tool output formatting + Next recommendation rules
- `core/git-hooks.ts` — git pre-commit hook integration
- `lsp/client.ts` — LSP JSON-RPC implementation
- `tools/_factory.ts` — createTool() factory: eliminates per-tool boilerplate
- `tools/overview.ts` — representative tool using the factory (others follow same shape)
- `hooks/before-start.ts` — system prompt injection pattern

## Key Directories

- `core/` — Pure analysis logic + git hook integration (no Pi/LSP imports)
- `lsp/` — External process management (language servers)
- `tools/` — Pi tool registration wrappers (one file per tool)
- `hooks/` — Automatic event handlers (not LLM-callable). See `docs/INSTRUCTION.md` §3.9
- `mcp/` — MCP server for non-Pi clients. See `docs/INSTRUCTION.md` §3.10
- `tests/` — vitest suite. See `docs/INSTRUCTION.md` §6

## Important Files

- `index.ts` — extension entry point and registration coordinator
- `core/output.ts` — standardized tool output formatting + Next recommendation rules
- `core/git-hooks.ts` — git pre-commit hook install/remove/verify
- `SKILL.md` — Pi agent skill file documenting all 14 tools for LLM discovery
- `AGENTS.md` — this file: architecture, conventions, workflows
- `README.md` — user-facing: Pi + MCP setup, tool list, language support
- `package.json` — npm manifest, dependencies, `bin` field for MCP entry
- `tsconfig.json` — TypeScript compiler configuration (must include `mcp/`)
- `types/pi-extension.d.ts` — self-contained ExtensionAPI type stub

## Docs Directory

Project documentation lives under `docs/`. Each guide covers a specific topic —
when working on that topic, read the corresponding guide first.

| Guide                     | Description                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/INSTRUCTION.md`     | **Single source of truth** for all development, maintenance, and release. Covers Pi ExtensionAPI contract (§1), architecture layers and design principles (§2), development workflow including tool/hook/MCP creation (§3), release & publish process (§4), tech stack management (§5), testing patterns and verification gates (§6), key files reference (§7). Read before any change. |
| `docs/kimi-code-hooks.md` | How to write Kimi Code hooks (shell scripts triggered by lifecycle events). Covers `config.toml` `[[hooks]]` setup, stdin JSON protocol, exit codes, all 15 lifecycle events. Use when adding hooks to Kimi Code's config.toml (external system, not pi-shazam).                                                                                                                        |

## Key Conventions

- **systemPrompt in hooks**: `before_agent_start.systemPrompt` may be `string` or `string[]` at runtime. Always check with `Array.isArray()` before calling `.some()` or `.push()`.
- **ctx.ui?.notify?.()**: Pi's `ExtensionUIContext` may not have `notify` in all modes. Always use optional chaining.
- **Hook return values**: `before_agent_start` handler returns `{ systemPrompt: string }` to replace. `tool_call` handler returns `{ block: true, reason: "..." }` to block.
- **Log directory**: All audit logs go to `~/.pi/hooks/audit/` (Pi) or `~/.kimi-code/audit/` (Kimi Code).

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
- AGENTS.md: Update this file whenever a new module, tool, command, or data flow is created.

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

## Pre-Commit Checklist

Before committing or creating a PR, verify ALL of the following:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm test` passes — 0 failures, 0 errors, 0 skipped
- [ ] `npm run build` succeeds with `dist/index.js` and `dist/index.d.ts` present
- [ ] `shazam_verify` called after all code changes (PASS/WARN verdict, no FAIL)
- [ ] AGENTS.md updated if new module/tool/command/hook was added
- [ ] MCP tools synced in `mcp/tools.ts` if Pi tools were changed
- [ ] README.md updated if user-facing features or tool list changed
- [ ] CHANGELOG.md updated if this is a release commit
- [ ] `tree-sitter-javascript` grammar loaded if `.js`/`.jsx`/`.mjs`/`.cjs` extensions added to `EXT_TO_LANG`
- [ ] All code comments, JSDoc, commit messages in English (no Chinese)
