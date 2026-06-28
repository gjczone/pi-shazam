---
name: pi-shazam
description: "MUST invoke BEFORE reading, editing, searching, or understanding ANY code in a project. pi-shazam builds a codebase graph (tree-sitter AST -> symbols -> dependencies -> PageRank) with 9 tools for query, verification, and safe code modification."
---

# pi-shazam

pi-shazam is a codebase analysis toolkit with two access paths:

- **Native Extension** — for the Pi coding agent. Tools register as first-class agent tools, appearing alongside `read`/`write`/`bash`.
- **MCP Server** (`npx pi-shazam-mcp`) — for Kimi Code, CodeBuddy, Claude, Qoder, and all other MCP-compatible agents.

Both paths share the same analysis engines (tree-sitter AST parsing, symbol dependency graph, PageRank scoring, LSP diagnostics). No duplication.

## Core Rules

1. **Shazam first, grep later.** Use shazam tools instead of grep/find for code understanding.
2. **`shazam_overview` first in every unfamiliar repo.** It shows the spine of the codebase in one call.
3. **`shazam_lookup` before using any symbol.** Verify it exists and understand its signature.
4. **`shazam_impact` before multi-file edits.** Assess blast radius before you break things.
5. **`shazam_verify` after every non-trivial edit.** The evidence gate — LSP diagnostics + graph analysis.
6. **JSON mode available on all tools.** Pass `{ "json": true }` for structured output.

## Query Tools

These tools read and analyze — they never modify files.

### shazam_overview

When you first enter a project or return after changes — use this to understand the codebase before reading a single file.

**Parameters**: `{ filter?, json?, maxTokens? }`

- `filter`: optional keyword to locate specific files
- `json`: set `true` for structured output
- `maxTokens`: limit output size

**Returns**: module dependency map, top-10 PageRank files (hotspots), key dependencies (from package.json), recent git commits, entry points (auto-detected CLI/HTTP/event handlers), key data structures (classes/interfaces/structs sorted by PageRank), reading order, HTTP routes (web projects). Key Dependencies and Recent Changes sections are suppressed in filter mode.

**When to use**: first turn in a new repo, after git clone, after switching to an unfamiliar project, deciding where to focus code review (hotspots show highest blast-radius files).

**Example**:

```
shazam_overview({})                          // full project overview with hotspots
shazam_overview({ filter: "auth" })          // locate auth-related files
```

### shazam_lookup

Unified symbol and file lookup. Combines symbol definition, type signature, documentation, file structure analysis, and type hierarchy into a single tool.

**Parameters**: `{ name: string, file?, mode?, showCallbacks?, direction?, json?, maxTokens? }`

- `name`: symbol name to look up, or a file path to analyze file structure
- `file`: optional file path to scope the symbol search
- `mode`: `"state"` for enum/class/interface state map analysis; `"search"` for fuzzy concept search (e.g., "how does authentication work"); if omitted and the symbol is not found, automatically falls back to search when the query looks like natural language
- `showCallbacks`: expand anonymous functions in call graph
- `direction`: type hierarchy traversal — `"both"` (default), `"supertypes"`, or `"subtypes"`

**Returns**: When `name` is a symbol: definition, kind, signature, file location, PageRank score, callers, callees, type signatures, documentation comments, and type hierarchy. When `name` is a file path: all symbols in the file with signatures, visibility, line ranges, incoming call count, PageRank score, and document symbol hierarchy.

**When to use**: before importing a module, before calling a function, checking symbol visibility, before changing enum variants (`mode=state`), understanding a symbol's type signature, getting API documentation, before editing a file for the first time (pass file path), understanding class inheritance (`direction` param), finding all interface implementations, searching for a concept across the codebase (`mode=search` or natural language query like "how is X implemented").

**Examples**:

```
shazam_lookup({ name: "createTool" })                        // symbol lookup
shazam_lookup({ name: "createTool", file: "tools/_factory.ts" })  // scoped to file
shazam_lookup({ name: "ToolKind", mode: "state" })           // enum state analysis
shazam_lookup({ name: "src/core/graph.ts" })                 // file structure
shazam_lookup({ name: "ExtensionAPI", direction: "subtypes" }) // type hierarchy
shazam_lookup({ name: "authentication", mode: "search" })       // concept search
shazam_lookup({ name: "how does caching work" })                 // natural language auto-search
```

### shazam_impact

Required before editing 2+ files or any shared/exported module. Also performs call chain analysis when a symbol is specified.

**Parameters**: `{ files?, symbol?, withSymbols?, compact?, depth?, flat?, direction?, json?, maxTokens? }`

- `files`: list of file paths you plan to edit (for file-level impact analysis)
- `symbol`: symbol name for call chain analysis (traces callers and callees)
- `withSymbols`: per-symbol risk breakdown
- `compact`: file names only, no detail
- `depth`: call chain traversal depth (default 3)
- `flat`: return simple flat list of all references
- `direction`: call chain direction — `"incoming"`, `"outgoing"`, or `"both"` (default)

**Returns**: When `files` is provided: every file, symbol, and test affected by your planned changes. When `symbol` is provided: incoming calls, outgoing calls, and full reference list for the symbol.

**When to use**: refactoring, adding a parameter to a shared function, changing a type definition, before any PR touching >1 file. Use `--symbol` when changing parameter order, removing a function, renaming an exported symbol, or changing return type.

**Examples**:

```
shazam_impact({ files: ["core/graph.ts", "tools/impact.ts"] })   // file impact
shazam_impact({ symbol: "createTool" })                           // call chain
shazam_impact({ symbol: "scanProject", depth: 4, direction: "incoming" })  // who calls scanProject
shazam_impact({ files: ["core/graph.ts"], withSymbols: true })    // symbol-level detail
```

## Write & Verification Tools

These tools modify files or verify changes.

### shazam_verify

After every write or edit, run this to confirm no errors were introduced. When diagnostics are found, fetches LSP codeAction suggested fixes.

**Parameters**: `{ quick?, lspOnly?, preCommit?, delta?, maxFiles?, noCascade?, noSecrets?, json?, maxTokens? }`

- `quick`: git changes + risk only (~2s)
- `lspOnly`: LSP diagnostics only, skip graph analysis
- `preCommit`: stricter thresholds for pre-commit gate
- `delta`: only check changed files
- `maxFiles`: max files to check
- `noCascade`: skip cascade analysis
- `noSecrets`: skip secrets detection

**Returns**: Verdict (PASS / WARN / FAIL), LSP diagnostics with suggested fixes, risk level, orphan detection, graph diffs.

**When to use**: after every non-trivial edit, before git commit, when CI is red.

**Example**:

```
shazam_verify({})                   // full verification
shazam_verify({ quick: true })      // fast git-change-only check
shazam_verify({ preCommit: true })  // strict pre-commit gate
```

### shazam_format

When code needs formatting, use this to auto-fix format and lint issues. Runs the nearest-wins formatter (prettier, biome, eslint --fix, ruff, cargo fmt, gofmt).

**Parameters**: `{ dryRun?, file?, json?, maxTokens? }`

- `dryRun`: preview changes without applying (default `true`)
- `file`: scope to a single file

**Returns**: list of fixes applied or previewed.

**When to use**: after shazam_verify reports format/lint errors, trailing whitespace, import sorting, indentation, line length, mixed tabs/spaces, missing newlines.

**Example**:

```
shazam_format({ dryRun: true })              // preview all fixes
shazam_format({ dryRun: false, file: "src/core/graph.ts" })  // apply to one file
```

### shazam_rename_symbol

Required safety gate before renaming any symbol. This is a WRITE operation — it performs the project-wide rename via LSP textDocument/rename.

**Parameters**: `{ symbol: string, newName: string, dryRun?, json?, maxTokens? }`

- `symbol`: current symbol name
- `newName`: new symbol name
- `dryRun`: preview only, do not modify files

**Safety workflow**: use `shazam_impact --symbol` first to review all references, then rename, then verify with `shazam_verify`.

**When to use**: renaming a public API function, renaming a widely-used type, changing a class name.

**Example**:

```
shazam_rename_symbol({ symbol: "oldName", newName: "newName", dryRun: true })  // preview
shazam_rename_symbol({ symbol: "oldName", newName: "newName" })                // execute
```

### shazam_safe_delete

Required safety gate before removing any symbol. READ-ONLY safety check; returns deletion guidance, does not delete.

**Parameters**: `{ symbol: string, dryRun?, json?, maxTokens? }`

- `symbol`: symbol name to delete
- `dryRun`: preview only, do not modify files

**Safety workflow**: verifies zero incoming references, reports outgoing references, provides deletion guidance. Do not delete based on intuition — a symbol that looks unused may be called dynamically.

**When to use**: removing dead code, cleaning up deprecated functions, removing a replaced utility.

**Example**:

```
shazam_safe_delete({ symbol: "unusedHelper" })
```

## Git Tools

Git change summary with risk level. Shows what changed in the working tree and assesses the risk of each change.

**Parameters**: `{ json?, maxTokens? }`

- No required parameters — uses the project root automatically.

**Returns**: list of changed files with change type (added/modified/deleted), risk assessment, and summary of changes.

**When to use**: before creating a commit, reviewing what you are about to push, understanding the scope of uncommitted changes.

**Example**:

```
shazam_changes({})
```

## LSP Integration

pi-shazam auto-detects language servers for supported languages:

| Language              | Server                      | Auto-Detect |
| --------------------- | --------------------------- | ----------- |
| TypeScript/JavaScript | typescript-language-server  | yes         |
| Python                | pyright                     | yes         |
| Rust                  | rust-analyzer               | yes         |
| Go                    | gopls                       | yes         |
| JSON                  | vscode-json-language-server | yes         |
| YAML                  | yaml-language-server        | yes         |
| Dart                  | dart                        | yes         |

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
- **Grammar support**: 7 languages via tree-sitter (Python, TypeScript, JavaScript, Go, Rust, Dart, JSON)
- **LSP**: 7 languages with auto-spawned language servers (Python, TypeScript, JavaScript, Go, Rust, JSON, YAML)
- **Install**: `npm install pi-shazam` in Pi extensions directory
