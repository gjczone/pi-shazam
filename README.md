# pi-shazam

> Native codebase awareness — unified structural analysis and LSP diagnostics as first-class tools for Pi agents and MCP clients.

[![npm version](https://img.shields.io/npm/v/pi-shazam)](https://www.npmjs.com/package/pi-shazam)
[![CI](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml/badge.svg)](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml)

pi-shazam builds a full dependency graph of your codebase — parsing every source file with tree-sitter, extracting symbols and their call/import relationships, ranking them with PageRank, and exposing the results through 13 analysis tools. Available as both a Pi extension and an MCP server (`npx pi-shazam-mcp`).

## Usage

### Pi Agent

```bash
pi install npm:pi-shazam
```

Tools appear as native Pi tools (`shazam_overview`, `shazam_verify`, etc.) alongside `read` and `bash`.

### MCP Clients (Cursor, Claude Desktop, Windsurf, Qoder)

```json
{
  "mcpServers": {
    "pi-shazam": {
      "command": "npx",
      "args": ["pi-shazam-mcp"]
    }
  }
}
```

No install needed — `npx` downloads and runs the latest version automatically.

## Tools (13)

### Query Tools

| Tool | Description |
|------|-------------|
| `shazam_overview` | Project structure, top-10 PageRank files, key dependencies, recent git changes, entry points, reading order, HTTP routes |
| `shazam_impact` | Blast radius analysis before multi-file edits — affected files, symbols, tests |
| `shazam_codesearch` | BM25 symbol search — use instead of grep, with camelCase/snake_case awareness |
| `shazam_symbol` | Symbol lookup — definition, kind, signature, callers, callees. Use `mode: "state"` for enum analysis |
| `shazam_hover` | Type signatures and documentation via LSP hover providers |
| `shazam_file_detail` | File structural breakdown — symbols, PageRank scores, call counts, LSP hierarchy |
| `shazam_call_chain` | Upstream callers and downstream callees with depth control. `flat: true` for reference list |
| `shazam_find_tests` | Discover test files for a module (supports `*.test.ts`, `*.spec.ts`, `__tests__/`) |
| `shazam_hotspots` | Complexity hotspots ranked by (symbol density x PageRank) |
| `shazam_type_hierarchy` | Class/interface inheritance chain — supertypes and subtypes |

### Write & Verify Tools

| Tool | Description |
|------|-------------|
| `shazam_verify` | Post-edit gate — LSP diagnostics + risk + orphans + graph diff. Modes: `quick`, `lspOnly`, `preCommit` |
| `shazam_fix` | Auto-fix format issues (prettier, biome, eslint, ruff, gofmt). Always `dryRun` first |
| `shazam_rename_symbol` | Safe rename — verify references first, then rename via LSP |
| `shazam_safe_delete` | Safe deletion — confirms zero incoming references before removal |

All tools return `{ content: [{ type: "text", text: "..." }] }` for MCP, or plain text / JSON for Pi.

## Automatic Hooks (Pi only)

- **before_agent_start**: scans the project and injects a structural overview into the system prompt
- **after_write/edit**: auto-verifies changes and reports structural impact

## Commands (Pi only)

| Command | Purpose |
|---------|---------|
| `/shazam-setup` | Detect installed language servers, print install instructions |
| `/shazam-doctor` | Health check: tree-sitter grammars, LSP servers, cache integrity |

## Languages

**Parsing (18)**: TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, C#, Ruby, CSS, HTML, JSON, YAML, Bash, Lua, Kotlin, Swift

**LSP (6)**: TypeScript/JavaScript, Python (pyright), Rust (rust-analyzer), Go (gopls), JSON, YAML

## Architecture

```
index.ts                    ← Pi extension entry
mcp/entry.ts                ← MCP server entry (npx pi-shazam-mcp)
    ↓                           ↓
tools/*.ts                  mcp/tools.ts
    ↓                           ↓
    └──── core/ + lsp/ ─────────┘
          (shared analysis engines)
```

Layer direction: `hooks/` → `tools/` → `core/` + `lsp/`. `mcp/` → `core/` + `lsp/`. Core has zero Pi or MCP imports.

## MCP Sync

When Pi extension tools change, MCP tools must be updated in the same PR:

| Pi change | MCP action |
|-----------|------------|
| New tool in `tools/` | Add `registerTool` in `mcp/tools.ts` |
| Tool deleted | Remove from `mcp/tools.ts` |
| Parameter schema changed | Update Zod schema in `mcp/tools.ts` |
| Description updated | Sync to MCP tool description |

## Development

```bash
git clone https://github.com/gjczone/pi-shazam.git
cd pi-shazam
npm install --legacy-peer-deps

npm run dev          # tsc --watch
npm run typecheck    # tsc --noEmit
npm test             # vitest (208 tests)
npm run build        # tsc → dist/
```

## License

MIT
