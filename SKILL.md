---
name: pi-shazam
description: "MUST invoke BEFORE reading, editing, searching, or understanding ANY code in a project. pi-shazam builds a codebase graph (tree-sitter AST → symbols → dependencies → PageRank) with 10 query tools + 4 write tools. Use shazam_overview first in every unfamiliar repo. Use shazam_codequery to find symbols and inspect files — faster and more accurate than grep. Use shazam_impact before editing 2+ files. Use shazam_verify after every non-trivial edit. Skipping pi-shazam = navigating blind — you WILL miss cross-module ripple effects and waste turns on dead-end reads."
---

# pi-shazam

pi-shazam is a Pi coding agent native extension that unifies tree-sitter AST parsing, symbol dependency graph analysis, PageRank scoring, and LSP diagnostics into a single toolkit. All tools are first-class Pi tools — LLM sees them alongside `read`/`write`/`bash` with no distinction.

## Core Rules

1. **Shazam first, grep later.** Use shazam_tools instead of grep/find for code understanding.
2. **`shazam_overview` before touching any new repo.** It shows the spine of the codebase in one call, including HTTP routes when web frameworks are detected.
3. **`shazam_codequery --symbol` before editing any function/class.** Verify it exists and see its callers. Use `--mode state` for enum/state machine analysis.
4. **`shazam_impact --files` before multi-file edits.** Assess blast radius before you break things.
5. **`shazam_verify` after every non-trivial edit.** The evidence gate — catch problems before commit.
6. **JSON mode available on all tools.** Pass `{ "json": true }` for structured output.

## Query Tools

These tools read and analyze — they never modify files.

| Situation | Tool | Notes |
|-----------|------|-------|
| First entry into any repo | `shazam_overview` | Module map, top-10 PageRank files, reading order, hotspots, HTTP routes (auto-detected) |
| Find symbol definition + references | `shazam_codequery --symbol <name>` | LSP precision + tree-sitter fallback; returns definition, callers, callees |
| Inspect a file's symbols | `shazam_codequery --file <path>` | All symbols with signatures, visibility, PageRank in one call |
| Search by keyword | `shazam_codequery --query <keyword>` | BM25 search with synonym expansion; ranked by PageRank |
| Full text search | `shazam_codesearch --query <text>` | BM25 symbol ranking across entire codebase |
| Deep file analysis | `shazam_file_detail --file <path>` | All symbols, PageRank scores, incoming/outgoing counts, import list |
| Single symbol lookup | `shazam_symbol --name <name>` | Definition, visibility, signature, call counts; use `--mode state` for enum/state map |
| Find all references | `shazam_refs --symbol <name>` | Every usage across the project (incoming + outgoing edges) |
| Assess blast radius | `shazam_impact --files <f1,f2,...>` | Affected files, key symbols at risk, suggested tests; use `--with-symbols` |
| Trace call chain | `shazam_call_chain --symbol <name>` | Upstream callers → downstream callees with PageRank |
| Complexity hotspots | `shazam_hotspots` | Files ranked by complexity + risk score |

## Write & Verification Tools

These tools modify files or verify changes.

| Situation | Tool | Notes |
|-----------|------|-------|
| After every edit | `shazam_verify` | Git diff → risk → LSP diagnostics → orphan detection → call-graph check |
| Quick post-edit check | `shazam_verify --quick` | Git changes + risk only (2s) |
| Before commit | `shazam_verify` (full) | All checks in one pass |
| Type/lint errors | `shazam_check` | Compiler diagnostics (tsc/pyright/rust-analyzer) + lint (eslint/ruff/clippy) |
| Auto-fix format | `shazam_fix` | Runs formatters (prettier, biome, ruff format, gofmt, cargo fmt); use `--dry-run` to preview |
| Pre-commit gate | `shazam_ready` | verify + check + fix — the final pre-commit readiness check |

## LSP Integration

pi-shazam auto-detects language servers for supported languages:

| Language | Server | Auto-Detect |
|----------|--------|-------------|
| TypeScript/JavaScript | typescript-language-server | ✅ |
| Python | pyright | ✅ |
| Rust | rust-analyzer | ✅ |
| Go | gopls | ✅ |
| JSON | vscode-json-languageserver | ✅ |
| YAML | yaml-language-server | ✅ |

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
  "result": { }
}
```

## Encoding

pi-shazam reads source files with adaptive encoding: UTF-8 → GBK → GB2312. It never assumes UTF-8. Chinese-character projects are handled automatically.

## Environment

- **Runtime**: Node.js ≥18, TypeScript ES2022, ESM
- **Grammar support**: 18 languages via tree-sitter
- **LSP**: 6 languages with auto-spawned language servers
- **Install**: `npm install pi-shazam` in Pi extensions directory
