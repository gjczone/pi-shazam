# pi-shazam

> Native codebase awareness extension for the Pi coding agent — unified structural analysis and LSP diagnostics as first-class LLM tools.

[![npm version](https://img.shields.io/npm/v/pi-shazam)](https://www.npmjs.com/package/pi-shazam)
[![CI](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml/badge.svg)](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml)

pi-shazam builds a full dependency graph of your codebase — parsing every source file with tree-sitter, extracting symbols and their call/import relationships, ranking them with PageRank, and exposing the results through LLM-callable Pi tools. The agent sees `shazam_overview` and `shazam_codequery` the same way it sees `read` and `bash`.

## Installation

```bash
pi install npm:pi-shazam
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-shazam@0.1.1"]
}
```

> Requires Node.js ≥ 18.

## What It Gives the Agent

### Before touching any code — `shazam_overview`

The first thing the agent should call in an unfamiliar repo. One call returns:

- **Module dependency map** — which directories depend on which
- **Top-10 files by PageRank** — the structural "spine" of the codebase
- **Entry points** — exported symbols with the most incoming references
- **Suggested reading order** — where to start understanding the code
- **Hotspots** — files with the highest complexity and risk

### Before editing a symbol — `shazam_codequery` / `shazam_refs` / `shazam_call_chain`

Before renaming, deleting, or changing any function, the agent checks:

| What | Which tool |
|------|-----------|
| Where is it defined? | `shazam_codequery --symbol <name>` |
| What's its signature and visibility? | `shazam_symbol --symbol <name>` |
| Who calls it? | `shazam_refs --symbol <name>` (incoming edges) |
| What does it call? | `shazam_refs --symbol <name>` (outgoing edges) |
| Full call chain? | `shazam_call_chain --symbol <name> --depth 2` |

### Before editing a file — `shazam_file_detail` / `shazam_codequery --file`

Reading raw source shows syntax; these tools show **structure**. The agent sees every symbol in the file with signatures, visibility, line ranges, incoming/outgoing reference counts, and PageRank scores — so it spots dependencies and side effects that raw reading misses.

### Before multi-file edits — `shazam_impact`

Pass the files you plan to change and get back:

- **Blast radius** — every file that references the symbols in your target files
- **Key symbols at risk** — high-PageRank symbols that would be affected
- **Suggested tests** — test files most likely to catch regressions
- **Risk level** — low / medium / high with specific reasons

### After every edit — `shazam_verify`

The evidence gate. After each write/edit, the agent runs:

1. **Git diff** → what actually changed
2. **Baseline comparison** → added/removed/modified symbols vs last snapshot
3. **Orphan detection** → symbols with zero incoming references (dead code candidates)
4. **Risk assessment** → low / medium / high based on change magnitude
5. **Call-graph consistency** → broken calls, broken imports

Use `--quick` for a 2-second risk-only check after each individual edit. Run the full verify before committing.

### Before committing — `shazam_ready`

The final gate. Composes verify + check into a single pass/fail readout:

```
Status: ✅ READY   or   ❌ NOT READY
- Risk level: low / medium / high
- Orphan symbols: N
- Files parsed: N / N
```

If not ready, it tells the agent exactly what to fix and which tools to run.

### When CI is red — `shazam_check`

Independent of git state. Runs tree-sitter parse validation across all project files and reports which files failed to parse, symbol counts, and edge statistics. For deeper diagnostics, points the agent to `npx tsc --noEmit` or language-specific linters.

### Format issues — `shazam_fix`

Detects available formatters from project config (prettier, eslint, biome) and scans files for:

- Trailing whitespace
- Tab indentation in space-convention files
- Mixed tabs and spaces
- Missing newline at end of file
- Consecutive blank lines (>2)

Always defaults to **dry-run mode** — shows what would change without touching files. The agent must explicitly pass `{ "dryRun": false }` to apply fixes.

### Finding dead code — `shazam_orphan`

Lists symbols with zero incoming references (filtering out exported entry points, anonymous functions, and test files). Confidence ≥ 70. Before deleting anything, the agent should also check for dynamic references.

### Finding complexity problems — `shazam_hotspots`

Ranks files by a composite of symbol count, edge density, and PageRank sum. The files at the top are where bugs are most likely to hide.

### HTTP APIs — `shazam_routes`

Discovers HTTP route registrations across the project — framework-agnostic pattern matching for Express, Flask, FastAPI, Gin, Actix, and more.

### State machines — `shazam_state_map`

Traces enum and constant definitions, their values, and transition relationships. Useful for understanding configuration states, feature flags, or finite state machines.

### Keyword search — `shazam_codesearch`

BM25-ranked symbol search across the entire codebase. Better than grep for finding "that function that handles authentication" when you don't know its exact name.

## All Tools at a Glance

| Tool | Type | Description |
|------|------|-------------|
| `shazam_overview` | Query | Project structure, modules, Top-10 PageRank files, reading order |
| `shazam_codequery` | Query | Unified lookup: `--symbol`, `--file`, or `--query` (keyword) |
| `shazam_codesearch` | Query | BM25 symbol search across entire codebase |
| `shazam_file_detail` | Query | Deep file analysis: all symbols, signatures, ref counts, imports |
| `shazam_symbol` | Query | Single symbol: definition, kind, visibility, call counts |
| `shazam_refs` | Query | All incoming + outgoing references for a symbol |
| `shazam_impact` | Query | Blast radius of planned file changes with risk level |
| `shazam_call_chain` | Query | Upstream callers → downstream callees with depth control |
| `shazam_routes` | Query | HTTP route inventory (framework-agnostic) |
| `shazam_state_map` | Query | Enum/state definitions and transitions |
| `shazam_orphan` | Query | Dead code candidates (zero incoming references) |
| `shazam_hotspots` | Query | Complexity-ranked file list |
| `shazam_verify` | Verify | Post-edit gate: diff, orphans, risk, call-graph consistency |
| `shazam_check` | Verify | Parse validation and symbol statistics (git-independent) |
| `shazam_fix` | Write | Auto-detect and preview format issues (dry-run by default) |
| `shazam_ready` | Verify | Pre-commit composition of verify + check |

All tools support `{ "json": true }` for structured output. Write tools use `{ "dryRun": true }` by default and require explicit opt-out to apply changes.

## Automatic Hooks

Two hooks run without the agent asking:

### Overview Injection (`before_agent_start`)

When the agent starts in a project, pi-shazam silently scans the codebase and injects a structural overview into the system prompt. The agent **sees the shape of the code before reading a single file**, eliminating the "where do I even start" problem.

### Post-Edit Verification (`tool_result` → `write`/`edit`)

After every file write or edit, pi-shazam re-scans the project and reports:

- Total symbols and files
- Graph changes since baseline (added/removed/modified)
- Orphan symbol count (with smarter filtering — skips exported entry points and test files)
- Edge count and file relationship coverage

Findings are sent as a message into the conversation so the agent is immediately aware of structural impacts.

## Commands

| Command | Purpose |
|---------|---------|
| `/shazam-setup` | Detect installed language servers, print install instructions for missing ones |
| `/shazam-doctor` | Full health check: tree-sitter grammars, LSP servers, cache integrity |

## Languages

### Tree-sitter Parsing (18 languages)

TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, C#, Ruby, CSS, HTML, JSON, YAML, Bash, Lua, Kotlin, Swift, Scala

### LSP Diagnostics (6 languages, auto-spawned)

| Language | Server |
|----------|--------|
| TypeScript / JavaScript | typescript-language-server |
| Python | pyright |
| Rust | rust-analyzer |
| Go | gopls |
| JSON | vscode-json-languageserver |
| YAML | yaml-language-server |

When a language server is unavailable, tools fall back to tree-sitter and annotate output with `(tree-sitter only, LSP unavailable)`. They never throw on missing LSP.

## Encoding

Adaptive file reading: UTF-8 → GBK → GB2312. Chinese-character source files are handled automatically. The scanner never assumes UTF-8.

## JSON Output Envelope

```json
{
  "schema_version": "1.0",
  "command": "<tool_name>",
  "project": "<absolute_path>",
  "status": "ok",
  "result": { }
}
```

## Architecture

```
index.ts                    ← Pi extension entry point (default export)
├── core/                   ← Pure analysis — zero Pi or LSP imports
│   ├── treesitter.ts       ← AST parsing + symbol extraction (18 languages)
│   ├── graph.ts            ← Symbol dependency graph (imports, calls, refs)
│   ├── pagerank.ts         ← PageRank scoring
│   ├── scanner.ts          ← Project walking + graph construction
│   ├── encoding.ts         ← Adaptive encoding (UTF-8 → GBK → GB2312)
│   └── cache.ts            ← Baseline save/load + graph diff
├── lsp/                    ← Language server process management
│   ├── manager.ts          ← Server lifecycle (spawn, stdio, health, shutdown)
│   ├── client.ts           ← JSON-RPC over stdio via vscode-jsonrpc
│   ├── servers.ts          ← Language → server config (6 languages)
│   └── setup.ts            ← /shazam-setup command logic
├── tools/                  ← One file per registerTool call (16 tools)
└── hooks/                  ← Automatic event handlers (not LLM-callable)
    ├── before-start.ts     ← Inject overview into system prompt
    └── after-write.ts      ← Auto-verify after write/edit operations
```

Layer direction: `hooks/` → `tools/` → `core/` + `lsp/`. Core never imports from tools, hooks, or lsp.

## Development

```bash
git clone https://github.com/gjczone/pi-shazam.git
cd pi-shazam
npm install --legacy-peer-deps

npm run dev          # tsc --watch
npm run typecheck    # tsc --noEmit
npm test             # vitest (98 tests)
npm run build        # tsc → dist/
```

## License

MIT
