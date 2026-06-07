# pi-shazam

> **Pi coding agent native codebase awareness toolkit** — 14 structural analysis tools for AI agents. Also supports MCP (Cursor, Claude Desktop, Windsurf, etc.)

[![npm version](https://img.shields.io/npm/v/pi-shazam)](https://www.npmjs.com/package/pi-shazam)
[![CI](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml/badge.svg)](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What It Does

**pi-shazam** is a native codebase analysis toolkit built for the **Pi coding agent**. It provides 14 structural analysis tools that help AI agents understand project architecture before reading code.

pi-shazam also supports **MCP (Model Context Protocol)**, allowing any compatible AI client to use the same analysis tools. Supported clients include Cursor, Claude Desktop, Windsurf, Qoder, Kimi Code, and more.

## Core Capabilities

- **Tree-sitter parsing** — 14 programming languages, full symbol dependency graph
- **PageRank ranking** — Identify core files and key symbols
- **LSP integration** — Type checking, diagnostics, type hierarchy (5 languages)
- **Incremental analysis** — Baseline comparison, focus on changes
- **Smart verification** — Post-edit verification with PASS/WARN/FAIL verdict

## Quick Start

### Pi Agent (Recommended)

```bash
pi install npm:pi-shazam
```

After installation, 14 analysis tools register as native Pi tools alongside `read`, `write`, and `bash`. Automatic hooks inject project structure into system prompts, verify code after edits, and log tool usage.

### MCP Clients (Cursor, Claude Desktop, etc.)

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

Works with all MCP-compatible clients. Same 14 tools, same analysis engine.

## Tools

### Query (Read-Only)

| Tool | What It Does |
|------|--------------|
| `shazam_overview` | Project structure, top-10 core files by PageRank, key dependencies, recent commits |
| `shazam_impact` | Change impact analysis: affected files, symbols, tests |
| `shazam_codesearch` | BM25 symbol search — ranked alternative to grep |
| `shazam_symbol` | Symbol definition, signature, callers, callees |
| `shazam_hover` | Type signatures and JSDoc — rich info from LSP |
| `shazam_file_detail` | All symbols in a file: signatures, PageRank, call counts, LSP hierarchy |
| `shazam_call_chain` | Full upstream/downstream call graph |
| `shazam_find_tests` | Find test files covering a module |
| `shazam_hotspots` | Files ranked by complexity — where bugs hurt most |
| `shazam_type_hierarchy` | Class/interface inheritance chain |

### Write & Verify

| Tool | What It Does |
|------|--------------|
| `shazam_verify` | Post-edit verification: LSP diagnostics + risk assessment + orphan detection |
| `shazam_fix` | Auto-fix format issues (prettier, biome, eslint, ruff, gofmt) |
| `shazam_rename_symbol` | Safe project-wide rename — verify references first |
| `shazam_safe_delete` | Delete with zero-reference confirmation |

## Platform Support

### Pi Agent Features

| Hook | Trigger | What It Does |
|------|---------|--------------|
| `before_agent_start` | Agent starts | Inject project structure overview into system prompt |
| `shazam-guide` | Key lifecycle | Guide agent to use tools at the right moments |
| `pre-edit-guard` | Before write | Detect multi-file edits, suggest `shazam_impact` first |

Additional commands: `/shazam-setup`, `/shazam-doctor`, `/shazam-install-git-hooks`, etc.

### MCP Client Support

pi-shazam's MCP server supports all MCP-compatible clients:

- **Cursor** — Built-in MCP support
- **Claude Desktop** — Via configuration file
- **Windsurf** — Native MCP support
- **Qoder** — AI coding assistant
- **Kimi Code** — Moonshot AI coding assistant
- **Others** — Any tool implementing MCP protocol

## Platform & Build

### npm Auto-Build

pi-shazam is published via npm with automatic platform support:

| Platform | Architecture | Status |
|----------|--------------|--------|
| **Linux** | x64, arm64 | Fully supported |
| **macOS** | x64 (Intel), arm64 (Apple Silicon) | Fully supported |

> **Note**: Windows is not supported due to path handling differences.

### Dependencies

pi-shazam uses `tree-sitter` for code parsing, a native Node.js module. npm automatically compiles binaries for your platform during installation — no manual steps required.

Supported Node.js versions: **>= 18.0.0**

### Community Format/Version Support

- **TypeScript/JavaScript**: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`
- **Python**: `.py`, `.pyi`, `.pyx`, `.pxd`
- **Rust**: `.rs`
- **Go**: `.go`
- **Java**: `.java`
- **C/C++**: `.c`, `.cpp`, `.h`, `.hpp`
- **C#**: `.cs`
- **Ruby**: `.rb`
- **Web**: `.css`, `.html`
- **Data formats**: `.json`, `.yaml`, `.yml`

## Architecture

```
pi-shazam (npm package)
├── Pi Extension                    MCP Server
│   index.ts ──tools/*.ts             mcp/entry.ts ──mcp/tools.ts
│       │         │                       │              │
│       └──── core/ + lsp/ ───────────────┘──────────────┘
│            (shared core, zero duplication)
│
├── hooks/                          Automatic hooks
│   ├── before-start.ts             Inject project overview
│   ├── pre-edit.ts                 Multi-file edit protection
│   ├── shazam-guide.ts             Tool usage guidance
│   └── tool-logger.ts              Usage analytics
│
└── core/ + lsp/                    Pure analysis engine (zero Pi/MCP dependencies)
```

## Development

```bash
git clone https://github.com/gjczone/pi-shazam.git
cd pi-shazam
npm install --legacy-peer-deps

npm run dev          # tsc --watch
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run build        # tsc → dist/
```

## LSP Support

| Language | LSP Server | Status |
|----------|-----------|--------|
| TypeScript/JavaScript | typescript-language-server | Supported |
| Python | pyright-langserver / pylsp | Supported |
| Go | gopls | Supported |
| Rust | rust-analyzer | Supported |
| YAML | yaml-language-server | Supported |

When LSP servers are unavailable, tools automatically fall back to tree-sitter mode.

## License

MIT

## Links

- [npm](https://www.npmjs.com/package/pi-shazam)
- [GitHub](https://github.com/gjczone/pi-shazam)
- [Pi Agent](https://pi.dev)
- [MCP Protocol](https://modelcontextprotocol.io)
