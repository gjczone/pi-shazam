# pi-gewu

Pi coding agent native codebase awareness extension. "格物致知" — agent gains deep structural understanding of a codebase before acting.

Rewrites the Python CLI project [repomap](https://github.com/gjczone/repomap) as a native Pi extension in TypeScript. All analysis capabilities register as first-class Pi tools — LLM sees them alongside `read`/`write`/`bash` with no distinction.

## Project Snapshot

- **Runtime**: TypeScript on Node.js ≥18, ES2022 target, NodeNext module resolution, ESM (`"type": "module"`)
- **Package**: npm `pi-gewu`, entry `dist/index.js` (default export function receiving `ExtensionAPI`)
- **Primary user flow**: LLM calls analysis tools (`overview`, `impact`, `codequery`, etc.) to understand code structure, change impact, and call chains before making edits
- **Architecture**: 4 layers — `core/` (parsing, graph, ranking), `lsp/` (language server management), `tools/` (Pi tool wrappers), `hooks/` (automatic verification)
- **External dependency**: Language servers (pyright, tsserver, rust-analyzer, gopls) are user-installed; pi-gewu manages process lifecycle
- **Release artifact**: npm package with `dist/` compiled output and `SKILL.md`

## Commands

| Command | Purpose |
|---------|---------|
| `npm install --legacy-peer-deps` | Install dependencies (legacy-peer-deps required for tree-sitter) |
| `npm run build` | Compile TS → `dist/` |
| `npm run typecheck` | `tsc --noEmit` — type validation without emit |
| `npm run dev` | `tsc --watch` — incremental compilation |
| `npm publish` | Build + publish to npm (runs `prepublishOnly`) |

## Development Environment

- Node.js ≥18, npm as package manager
- `types/pi-extension.d.ts` provides self-contained `ExtensionAPI` type stub (extracted from `@oh-my-pi/pi-coding-agent@15.8.0`)
- `npm install --legacy-peer-deps` required due to tree-sitter grammar peer dependency conflicts
- `tree-sitter@^0.22.4` pinned via `overrides` in package.json
- `vscode-languageserver-protocol` for LSP type definitions
- `iconv-lite` for UTF-8/GBK/GB2312 encoding fallback
- Test the extension by symlinking `dist/` into `~/.pi/agent/extensions/pi-gewu` or configuring in Pi settings

## Architecture

```
index.ts                    ← Pi extension entry, default export(pi: ExtensionAPI)
├── core/                   ← Pure analysis logic, no Pi dependency
│   ├── treesitter.ts       ← AST parsing + symbol extraction (18 languages)
│   ├── graph.ts            ← Symbol dependency graph (imports, calls, references)
│   ├── pagerank.ts         ← PageRank symbol importance scoring
│   ├── impact.ts           ← Change blast radius analysis
│   ├── encoding.ts         ← UTF-8 → GBK → GB2312 adaptive encoding
│   └── cache.ts            ← Graph baseline save/diff
├── lsp/                    ← Language server process management
│   ├── manager.ts          ← Server lifecycle (spawn, stdio, health, shutdown)
│   ├── client.ts           ← LSP protocol communication (JSON-RPC over stdio)
│   ├── servers.ts          ← Language→server config table (17 languages)
│   └── setup.ts            ← /gewu-setup command: detect + install guidance
├── tools/                  ← One file per registerTool call
│   ├── overview.ts         ← Project structure summary
│   ├── impact.ts           ← File-level change impact
│   ├── codequery.ts        ← Unified symbol/file query
│   ├── codesearch.ts       ← BM25 symbol search
│   ├── file_detail.ts      ← Single file deep analysis
│   ├── call_chain.ts       ← Call graph traversal
│   ├── symbol.ts           ← Symbol lookup
│   ├── refs.ts             ← Reference finder
│   ├── routes.ts           ← HTTP route inventory
│   ├── state_map.ts        ← State definition discovery
│   ├── verify.ts           ← Post-edit diagnostics gate
│   ├── fix.ts              ← Auto-fix lint/format
│   ├── ready.ts            ← Pre-commit readiness
│   ├── check.ts            ← Compiler/lint diagnostics
│   ├── orphan.ts           ← Dead code detection
│   └── hotspots.ts         ← Complexity hotspot ranking
└── hooks/                  ← Automatic (not LLM-visible)
    ├── before-start.ts     ← Inject overview into system prompt
    └── after-write.ts      ← Auto verify + fix after write/edit
```

### Layer dependency direction

`hooks/` → `tools/` → `core/` + `lsp/`. The `core/` layer has zero Pi or LSP imports. Tools compose core functions and optionally enrich with LSP data. Hooks call tool logic directly and inject results into LLM context via `pi.sendMessage()`.

## Core Flows

- **Overview injection**: `before_agent_start` event → `core/treesitter` scan → `core/pagerank` → format summary → inject into `systemPrompt` array
- **Tool call**: LLM calls tool → `tools/*.execute()` → `core/` analysis (tree-sitter parse → graph build → pagerank) → optional LSP enrichment → return `AgentToolResult`
- **Auto-verify**: `tool_call` event (write/edit) → `hooks/after-write` → `core/` diagnostics + LSP `textDocument/publishDiagnostics` → `pi.sendMessage()` with findings
- **LSP lifecycle**: extension load → `lsp/manager` detects project languages → spawns servers on demand → `lsp/client` handles JSON-RPC over stdio → `session_shutdown` kills all

## API Surface

### Registered Tools (LLM-visible)

All tools follow the same pattern:
- Parameters: Zod schema via `pi.typebox` or `pi.zod`
- Output: `{ content: [{ type: "text", text: string }] }` — plain text for LLM reading
- Optional `{ json: true }` parameter for structured JSON output
- Write-operation tools support `{ dryRun: true }`

### Registered Commands

- `/gewu-setup` — detect installed language servers, output install instructions for missing ones
- `/gewu-doctor` — health check: verify tree-sitter grammars, LSP servers, cache integrity

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

- **Adding a new tool**: Create `tools/<name>.ts` with `register*` function → import and call in `index.ts` → add Zod parameter schema → implement `execute()` calling `core/` functions
- **Adding a new language**: Add grammar to `core/treesitter.ts` EXT_TO_LANG map → add tree-sitter query in queries section → add LSP server config in `lsp/servers.ts`
- **Changing graph algorithm**: Modify `core/pagerank.ts` or `core/graph.ts` → verify all tools that consume `RepoGraph` still produce correct output
- **Changing LSP protocol**: Modify `lsp/client.ts` → verify `lsp/manager.ts` lifecycle still works → test with at least 2 different language servers
- **Changing tool output format**: Update the specific `tools/*.ts` formatter → update `SKILL.md` usage examples → verify JSON envelope schema

## Verification Matrix

| Change Type | Focused Check | Broader Gate |
|-------------|---------------|--------------|
| Any TS file | `npm run typecheck` | `npm run build` |
| Core logic | Manual test via Pi with symlinked extension | Full tool call in Pi session |
| Tool addition | typecheck + tool visible in `pi /tools` | Tool returns valid output on sample repo |
| Hook change | typecheck + manual write/edit trigger in Pi | Verify + fix results appear in LLM context |
| LSP change | typecheck + `/gewu-doctor` | Spawn server, get diagnostics for sample file |

## First Places to Inspect

- `index.ts` — extension entry, all registrations
- `core/treesitter.ts` — language support, symbol extraction entry
- `core/graph.ts` — how symbols become a dependency graph
- `lsp/client.ts` — LSP JSON-RPC implementation
- `tools/overview.ts` — representative tool pattern (others follow same shape)
- `hooks/before-start.ts` — system prompt injection pattern

## Key Directories

- `core/` — Pure analysis, no external I/O beyond filesystem reads
- `lsp/` — External process management (language servers)
- `tools/` — Pi tool registration wrappers (one file per tool)
- `hooks/` — Automatic event handlers (not LLM-callable)

## Important Files

- `index.ts` — extension entry point and registration coordinator
- `package.json` — npm manifest, dependencies, build scripts
- `tsconfig.json` — TypeScript compiler configuration
- `types/pi-extension.d.ts` — self-contained ExtensionAPI type stub (source of truth for Pi API types)
- `SKILL.md` — LLM-facing tool usage guide (shipped with package)
- `goal.md` — original design document (development reference, not shipped)

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

- Pi extension API: Import types from `./types/pi-extension.js` (local stub). Use `ExtensionAPI`, `ExtensionContext`, `AgentToolResult` — do not redefine these types.
- Tool naming: Prefix query tools with `code*` or `gewu_*` to avoid conflicts with other Pi extensions (e.g., `codequery` not `query`).
- SKILL.md: Only document LLM-visible query tools. Verification tools (verify/fix/check/ready) are hook-driven — document them as automatic, not callable.
- Symbol IDs: Format as `{file}::{name}::{line}` to match the repomap convention. Keep this stable — other tools depend on it.

</general-project-rules>
