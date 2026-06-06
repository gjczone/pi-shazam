# pi-shazam

> Give your AI agent structural awareness of your codebase — before it reads a single file.

[![npm version](https://img.shields.io/npm/v/pi-shazam)](https://www.npmjs.com/package/pi-shazam)
[![CI](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml/badge.svg)](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml)

## What It Solves

AI coding agents start blind. They see a file tree, maybe a README. They don't know which files are the "spine" of the project, what depends on what, or which callers will break when a function signature changes. They guess. Sometimes they guess wrong.

pi-shazam answers the questions every agent should ask before touching code:

- "What's the structure of this project?" → `shazam_overview`
- "What will break if I change this file?" → `shazam_impact`
- "Who calls this function?" → `shazam_call_chain`
- "Did my edit introduce errors?" → `shazam_verify`

Under the hood it parses **every source file** with tree-sitter (18 languages), builds a **full dependency graph** (symbols, imports, calls, references), ranks them with **PageRank**, and optionally enriches results with **LSP diagnostics** (6 languages). The agent gets precise, ranked answers in one call — no grep, no guesswork.

## Primary: Pi Package

pi-shazam is a **Pi coding agent package** — the native, first-class experience. Install once, tools appear alongside `read` and `bash`:

```bash
pi install npm:pi-shazam
```

All 13 analysis tools register as native Pi tools. Automatic hooks inject structural overviews into the system prompt, verify code after every edit, and log tool usage for optimization. This is the recommended setup for Pi users.

## Also: MCP Server

pi-shazam ships with an MCP server (`npx pi-shazam-mcp`) so **any MCP-compatible client** can use the same analysis tools. No Pi required.

Supported clients: Cursor, Claude Desktop, Windsurf, Qoder, Kimi Code, and any tool that speaks MCP.

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

The same 13 tools, the same analysis engine, the same output format. MCP tools sync with Pi tools in every release.

## Tools

### Query (read-only)

| Tool | What it tells the agent |
|------|------------------------|
| `shazam_overview` | Project structure, top-10 files by PageRank, key dependencies, recent commits, HTTP routes |
| `shazam_impact` | Every file, symbol, and test affected by your planned changes |
| `shazam_codesearch` | BM25-ranked symbol search — use instead of grep |
| `shazam_symbol` | Definition, kind, signature, callers, callees for any symbol. `mode: "state"` for enums |
| `shazam_hover` | Type signatures and JSDoc via LSP — content raw reads miss |
| `shazam_file_detail` | All symbols in a file with signatures, PageRank, call counts, LSP hierarchy |
| `shazam_call_chain` | Full upstream/downstream call graph. `flat: true` for reference list |
| `shazam_find_tests` | Which test files cover a given module |
| `shazam_hotspots` | Files ranked by complexity — where bugs hurt most |
| `shazam_type_hierarchy` | Class/interface inheritance chain |

### Write & Verify

| Tool | What it tells the agent |
|------|------------------------|
| `shazam_verify` | Post-edit gate: LSP diagnostics + risk + orphans + graph diff. PASS/WARN/FAIL |
| `shazam_fix` | Auto-fix format issues (prettier, biome, eslint, ruff, gofmt) |
| `shazam_rename_symbol` | Safe project-wide rename via LSP — verifies references first |
| `shazam_safe_delete` | Confirms zero incoming references before removing a symbol |

## Pi-Only Features

These run automatically when installed as a Pi package:

| Hook | When | What it does |
|------|------|-------------|
| `before_agent_start` | Agent starts | Injects project structure overview into system prompt |
| `after_write/edit` | Agent writes/edits | Auto-verifies changes, reports structural impact |
| `shazam-guide` | Key lifecycle events | Nudges agent to use shazam tools at the right moments |
| `tool-logger` | Every shazam call | Logs usage to `~/.pi/hooks/audit/shazam-calls.log` for optimization |

Plus two commands: `/shazam-setup` (LSP server detection) and `/shazam-doctor` (health check).

## Supported Languages

**Tree-sitter parsing (14)**: TypeScript/TSX, JavaScript/JSX, Python, Rust, Go, Java, C, C++, C#, Ruby, CSS, HTML, JSON

**LSP diagnostics (6)**: TypeScript/JavaScript, Python (pyright), Rust (rust-analyzer), Go (gopls), JSON, YAML

When LSP servers are unavailable, tools fall back to tree-sitter only.

## Architecture

```
pi-shazam (npm package)
├── Pi extension                  MCP server
│   index.ts ──tools/*.ts         mcp/entry.ts ──mcp/tools.ts
│       │         │                   │              │
│       └──── core/ + lsp/ ───────────┘──────────────┘
│            (shared, no duplication)
│
├── hooks/
│   ├── before-start.ts    inject overview into prompt
│   ├── after-write.ts     auto-verify after edits
│   ├── shazam-guide.ts    nudge agent to use tools
│   └── tool-logger.ts     usage analytics
│
└── core/ + lsp/           pure analysis (zero Pi/MCP imports)
```

## MCP Sync Discipline

Pi and MCP tools ship in the same package, from the same codebase. When Pi tools change, MCP tools must update in the same PR:

| Pi change | MCP action |
|-----------|------------|
| New tool | Add `registerTool` in `mcp/tools.ts` |
| Tool deleted | Remove from `mcp/tools.ts` |
| Schema changed | Update Zod schema |
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
