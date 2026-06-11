---
name: pi-shazam
description: "MUST invoke BEFORE reading, editing, searching, or understanding ANY code in a project. pi-shazam builds a codebase graph (tree-sitter AST -> symbols -> dependencies -> PageRank) with 14 tools for query, verification, and safe code modification."
---

# pi-shazam

pi-shazam is a Pi coding agent native extension that unifies tree-sitter AST parsing, symbol dependency graph analysis, PageRank scoring, and LSP diagnostics into a single toolkit. All tools are first-class Pi tools — LLM sees them alongside `read`/`write`/`bash` with no distinction.

Also available as an MCP server (`npx pi-shazam-mcp`) for non-Pi clients (Cursor, Claude Desktop, Windsurf, Qoder).

## Core Rules

1. **Shazam first, grep later.** Use shazam_tools instead of grep/find for code understanding.
2. **`shazam_overview` first in every unfamiliar repo.** It shows the spine of the codebase in one call.
3. **`shazam_symbol` before using any symbol.** Verify it exists and understand its signature.
4. **`shazam_impact` before multi-file edits.** Assess blast radius before you break things.
5. **`shazam_verify` after every non-trivial edit.** The evidence gate — LSP diagnostics + graph analysis.
6. **JSON mode available on all tools.** Pass `{ "json": true }` for structured output.

## Query Tools

These tools read and analyze — they never modify files.

### shazam_overview

When you first enter a project or return after changes — use this to understand the codebase before reading a single file.

**Parameters**: `{ filter?, json? }`

- `filter`: optional keyword to locate specific files
- `json`: set `true` for structured output

**Returns**: module dependency map, top-10 PageRank files, key dependencies (from package.json), recent git commits, entry points, reading order, HTTP routes (web projects). Key Dependencies and Recent Changes sections are suppressed in filter mode.

**When to use**: first turn in a new repo, after git clone, after switching to an unfamiliar project.

### shazam_impact

Required before editing 2+ files or any shared/exported module.

**Parameters**: `{ files: string[], withSymbols?, compact? }`

- `files`: list of file paths you plan to edit
- `withSymbols`: per-symbol risk breakdown
- `compact`: file names only, no detail

**Returns**: every file, symbol, and test affected by your planned changes.

**When to use**: refactoring, adding a parameter to a shared function, changing a type definition, before any PR touching >1 file.

### shazam_codesearch

Don't reach for grep or raw text search across the codebase. Use this instead — it ranks results by relevance.

**Parameters**: `{ query: string, target?, topN? }`

- `query`: search text
- `target`: `"symbol"` (default, BM25 semantic ranking) or `"code"` (full-text via ripgrep)
- `topN`: limit results count

**Returns**: ranked symbol matches or full-text snippets with context.

**When to use**: finding error handling patterns, locating callers by name, searching TODO/FIXME comments.

### shazam_symbol

When you need to look up a symbol before importing or calling it.

**Parameters**: `{ name: string, file?, mode? }`

- `name`: symbol name to look up
- `file`: optional file path to scope the search
- `mode`: `"state"` for enum/class/interface state map analysis

**Returns**: definition, kind, signature, file location, PageRank score, callers, callees. LSP adds container and endLine.

**When to use**: before importing a module, before calling a function, checking symbol visibility, before changing enum variants or state transitions (use `mode=state`).

### shazam_hover

After finding a symbol with shazam_symbol, use this to get its full type signature and documentation. When position is inside a function call, also returns signatureHelp with active parameter info.

**Parameters**: `{ name: string, file? }`

- `name`: symbol name
- `file`: optional file path to scope lookup

**Returns**: type signatures, documentation comments, JSDoc from LSP hover providers, and signatureHelp for function call context. Falls back to graph metadata when LSP unavailable.

**When to use**: understanding a symbol's type signature, checking parameter types, getting API documentation, seeing function parameter info when making calls.

### shazam_file_detail

When you are about to edit a file you have not read before — this shows structure, not just syntax. Also shows reference counts via LSP codeLens when available.

**Parameters**: `{ file: string }`

- `file`: path to the file to analyze

**Returns**: all symbols with signatures, visibility, line ranges, incoming call count, PageRank score. LSP adds document symbol hierarchy.

**When to use**: before editing a file for the first time, before refactoring a large file, after a PR to understand structural changes.

### shazam_call_chain

Without this, you ship bugs. Every caller you miss when changing a function signature is a runtime error.

**Parameters**: `{ symbol: string, depth?, flat? }`

- `symbol`: symbol name to trace
- `depth`: traversal depth (default 2)
- `flat`: return simple flat list of all references

**Returns**: incoming calls, outgoing calls, full reference list.

**When to use**: changing parameter order, removing a function, renaming an exported symbol, changing return type.

### shazam_find_tests

When adding tests or modifying source code — use this to discover which test files already cover a module.

**Parameters**: `{ sourceFile?, module? }`

- `sourceFile`: path to source file
- `module`: module name to scope search

**Returns**: test file paths, test function names, coverage hints. Understands `*.test.ts`, `*.spec.ts`, `__tests__/` conventions.

**When to use**: before adding tests, before refactoring a module, after changing code to locate tests that need updating.

### shazam_hotspots

Without this, you optimize the wrong files. Returns files where bugs have the highest blast radius.

**Parameters**: `{ topN? }`

- `topN`: number of top hotspots to return

**Returns**: files ranked by (symbol density x PageRank score).

**When to use**: code review prioritization, deciding where to write tests first, understanding project core.

### shazam_type_hierarchy

When working with classes, interfaces, or abstract types — use this to see the full inheritance chain and implementations.

**Parameters**: `{ name: string, file? }`

- `name`: symbol name
- `file`: optional file path

**Returns**: supertypes (parents, interfaces), subtypes (children, implementations), and implementation locations for interface/trait types via LSP textDocument/implementation. Uses LSP 3.17 typeHierarchy protocol with graph fallback.

**When to use**: understanding class inheritance before refactoring, finding all interface implementations, checking subtype relationships.

## Write & Verification Tools

These tools modify files or verify changes.

### shazam_verify

After every write or edit, run this to confirm no errors were introduced. When diagnostics are found, fetches LSP codeAction suggested fixes.

**Parameters**: `{ quick?, lspOnly?, preCommit? }`

- `quick`: git changes + risk only (~2s)
- `lspOnly`: LSP diagnostics only, skip graph analysis
- `preCommit`: stricter thresholds for pre-commit gate

**Returns**: Verdict (PASS / WARN / FAIL), LSP diagnostics with suggested fixes, risk level, orphan detection, graph diffs.

**When to use**: after every non-trivial edit, before git commit, when CI is red.

### shazam_fix

When shazam_verify reports format or lint errors, use this to auto-fix them.

**Parameters**: `{ dryRun?, file? }`

- `dryRun`: preview changes without applying
- `file`: scope to a single file

**Returns**: list of fixes applied or previewed. Runs prettier, biome, eslint --fix, ruff, cargo fmt, gofmt.

**When to use**: trailing whitespace, import sorting, indentation, line length, mixed tabs/spaces, missing newlines.

### shazam_rename_symbol

Required safety gate before renaming any symbol. This is a WRITE operation.

**Parameters**: `{ name: string, file: string, newName: string }`

- `name`: current symbol name
- `file`: file containing the symbol
- `newName`: new symbol name

**Safety workflow**: call shazam_call_chain first to review references, then rename, then verify with shazam_verify.

**When to use**: renaming a public API function, renaming a widely-used type, changing a class name.

### shazam_safe_delete

Required safety gate before removing any symbol. This is a WRITE operation.

**Parameters**: `{ name: string, file: string }`

- `name`: symbol name to delete
- `file`: file containing the symbol

**Safety workflow**: verifies zero incoming references, reports outgoing references, provides deletion guidance.

**When to use**: removing dead code, cleaning up deprecated functions, removing a replaced utility.

## LSP Integration

pi-shazam auto-detects language servers for supported languages:

| Language              | Server                     | Auto-Detect |
| --------------------- | -------------------------- | ----------- |
| TypeScript/JavaScript | typescript-language-server | yes         |
| Python                | pyright                    | yes         |
| Rust                  | rust-analyzer              | yes         |
| Go                    | gopls                      | yes         |
| JSON                  | vscode-json-languageserver | yes         |
| YAML                  | yaml-language-server       | yes         |

When a language server is unavailable, tools fall back to tree-sitter only and annotate output with `(tree-sitter only, LSP unavailable)`.

Run `/shazam-setup` to check LSP availability and get install instructions. Run `/shazam-doctor` for a full health check.

## JSON Output Envelope

All tools support `{ "json": true }` for structured output:

```json
{
	"schema_version": "1.0",
	"command": "<tool_name>",
	"project": "<absolute_path>",
	"status": "ok",
	"result": {}
}
```

## Encoding

pi-shazam reads source files with adaptive encoding: UTF-8 -> GBK -> GB2312. It never assumes UTF-8.

## Environment

- **Runtime**: Node.js >=18, TypeScript ES2022, ESM
- **Grammar support**: 5 languages via tree-sitter (Python, TypeScript, Go, Rust, JSON)
- **LSP**: 5 languages with auto-spawned language servers
- **Install**: `npm install pi-shazam` in Pi extensions directory
