# pi-shazam

> **Pi coding agent native codebase awareness toolkit** — 9 structural analysis tools built natively for Pi agent. MCP support available for non-Pi agents (Cursor, Claude Code, Qoder, Trae, Codebuddy, etc.)

[![npm version](https://img.shields.io/npm/v/pi-shazam)](https://www.npmjs.com/package/pi-shazam)
[![CI](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml/badge.svg)](https://github.com/gjczone/pi-shazam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **100% Vibe Coding** — This entire project (core analysis engine, 9 tools, hooks, LSP integration, MCP server, CI/CD, documentation) was built using [Pi coding agent](https://pi.dev) powered primarily by **DeepSeek-V4-Pro**, **MiMo-V2.5-Pro**, and **Qwen3.7-Max**. Zero hand-written code. Every line, every test, every architecture decision — generated and refined by AI, verified by automated CI.

## What It Does

**pi-shazam** is a native codebase analysis toolkit built for the **Pi coding agent**. It provides 9 structural analysis tools that help AI agents understand project architecture before reading code.

For non-Pi agents, pi-shazam also exposes the same tools via **MCP (Model Context Protocol)**. Supported MCP clients include Cursor, Claude Code, Qoder, Trae, Codebuddy, Kimi Code, and more. **Note: the MCP interface is a compatibility layer — the primary and recommended deployment model is as a native Pi extension.**

## Core Capabilities

- **Tree-sitter parsing** — 7 programming languages (Python, TypeScript, JavaScript, Go, Rust, Dart, JSON), full symbol dependency graph
- **PageRank ranking** — Identify core files and key symbols
- **LSP integration** — Type checking, diagnostics, type hierarchy (7 languages)
- **Incremental analysis** — Baseline comparison, focus on changes
- **Smart verification** — Post-edit verification with PASS/WARN/FAIL verdict

## Quick Start

### Pi Agent (Default — Recommended)

**This is the primary installation method.** pi-shazam is designed and optimized for Pi agent first.

```bash
pi install npm:pi-shazam
```

After installation, all 9 analysis tools register as native Pi tools alongside `read`, `write`, and `bash`. Automatic hooks inject project structure into system prompts, verify code after edits, and log tool usage. **Full hook lifecycle (before_agent_start, session_start, session_shutdown, tool_call, tool_result) available only in Pi mode.**

### MCP (For Non-Pi Agents Only)

Use this only if you are **not** using Pi agent. The MCP interface provides the same 9 tools with LSP support but without Pi-specific hooks and lifecycle integration.

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam", "pi-shazam-mcp"]
		}
	}
}
```

Compatible with any MCP-capable client. Same analysis engine, JSON-based tool interface.

## Tools

### Query (Read-Only)

| Tool                | What It Does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `shazam_overview`   | Project structure + hotspots + deps + routes                             |
| `shazam_lookup`     | Symbol/file lookup with type hierarchy, hover, LSP enrichment            |
| `shazam_impact`     | File impact + symbol call chain analysis (BFS depth tracking, default 3) |
| `shazam_changes`    | Git change summary with risk level                                       |
| `shazam_find_tests` | Find test files covering a module                                        |

### Write & Verify

| Tool                   | What It Does                                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| `shazam_verify`        | Post-edit verification: LSP diagnostics + codeAction fixes + risk + orphans |
| `shazam_format`        | Auto-format code (prettier, biome, eslint, ruff, gofmt)                     |
| `shazam_rename_symbol` | Safe project-wide rename — verify references first                          |
| `shazam_safe_delete`   | Delete with zero-reference confirmation                                     |

## Platform Support

### Pi Agent Hooks

| Hook                  | Event                              | What It Does                                                                                 |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `before-start`        | `before_agent_start`               | Inject project structure overview + proactive recommendations into system prompt             |
| `safety`              | `tool_call` (bash)                 | Destructive command confirmation dialog + Pre-commit gate (blocks git commit without verify) |
| `shazam-guide`        | `tool_result`                      | Auto-format files after write/edit + contextual tool suggestions                             |
| `stop-verify`         | `turn_end`                         | Remind to run `shazam_verify` before ending turn                                             |
| `failure-recovery`    | `tool_result`                      | Detect consecutive failures (3x/5x) and suggest alternatives                                 |
| `pre-edit`            | `tool_call`                        | Detect multi-file edits, warn about blast radius                                             |
| `tool-logger`         | `tool_call` + `tool_result`        | Log all shazam tool calls to `~/.pi/hooks/audit/shazam-calls.log`                            |
| `issue-guard`         | `tool_call` (bash) + `tool_result` | Detects `gh issue create`, blocks edits until `shazam_impact` runs                           |
| `agent-context-guard` | `tool_call` (agent)                | Blocks agent spawn without structural context for review tasks                               |

**Auto-format support**: ruff (Python), prettier (JS/TS/JSON/MD), eslint (JS/TS), gofmt (Go), rustfmt (Rust), biome (JS/TS)

Additional commands: `/shazam-setup`, `/shazam-doctor`, `/shazam-install-git-hooks`, `/shazam-remove-git-hooks`, `/shazam-pre-commit-verify`

### MCP Client Support

pi-shazam's MCP server supports all MCP-compatible clients:

- **Cursor** — Built-in MCP support
- **Claude Code** — Anthropic's coding agent (CLI)
- **Qoder** — AI coding assistant
- **Trae** — ByteDance's AI coding IDE
- **Codebuddy** — Tencent's AI coding assistant
- **Kimi Code** — Moonshot AI coding assistant
- **Others** — Any tool implementing MCP protocol

## Platform & Build

### npm Auto-Build

pi-shazam is published via npm with automatic platform support:

| Platform  | Architecture                       | Status          |
| --------- | ---------------------------------- | --------------- |
| **Linux** | x64, arm64                         | Fully supported |
| **macOS** | x64 (Intel), arm64 (Apple Silicon) | Fully supported |

> **Note**: Windows is not supported due to path handling differences.

### Dependencies

pi-shazam uses `tree-sitter` for code parsing, a native Node.js module. npm automatically compiles binaries for your platform during installation — no manual steps required.

Supported Node.js versions: **>= 18.0.0**

### Community Format/Version Support

- **TypeScript**: `.ts`, `.tsx`, `.mts`, `.cts`
- **JavaScript**: `.js`, `.jsx`, `.mjs`, `.cjs`
- **Python**: `.py`, `.pyi`
- **Go**: `.go`
- **Rust**: `.rs`
- **Dart**: `.dart` (Flutter supported)
- **Data formats**: `.json`

## Architecture

```
pi-shazam (npm package)
│
├── hooks/                              Automatic hooks (hooks → tools → core)
│   ├── before-start.ts                 Inject project overview into system prompt
│   ├── safety.ts                       Destructive command confirmation + pre-commit gate
│   ├── pre-edit.ts                     Multi-file edit protection
│   ├── shazam-guide.ts                 Auto-format + tool usage guidance
│   ├── stop-verify.ts                  Turn-end verification reminder
│   ├── failure-recovery.ts             Consecutive failure detection
│   ├── tool-logger.ts                  Usage analytics
│   ├── verify-state.ts                 Shared verify tracking state for safety + stop-verify
│   ├── impact-state.ts                 Shared impact tracking state for issue-guard + pre-edit
│   ├── issue-guard.ts                  Detect gh issue create, set pending impact flag
│   └── agent-context-guard.ts          Block agent spawn without structural context
│
├── tools/                              Pi tool wrappers (tools → core + lsp)
│   ├── definitions.ts                  Shared tool definitions (names, descriptions, schemas)
│   ├── _factory.ts                     Tool registration factory
│   ├── _context.ts                     Shared LSP manager holder
│   ├── lsp_enrich.ts                   LSP enrichment wrappers
│   ├── overview.ts ─── lookup.ts ─── impact.ts
│   ├── verify.ts ─── changes.ts ─── format.ts
│   ├── find_tests.ts ─── rename_symbol.ts ─── safe_delete.ts
│   │
│   └── Pi Extension (index.ts)         MCP Server (mcp/entry.ts ── mcp/tools.ts)
│           │                                   │
│           └────────── core/ + lsp/ ───────────┘
│                   (shared engine, zero duplication)
│
├── lsp/                                Language server management
│   ├── manager.ts                      Server lifecycle (spawn, stdio, health, shutdown)
│   ├── client.ts                       LSP protocol via vscode-jsonrpc
│   ├── servers.ts                      Language → server config (6 languages)
│   └── setup.ts                        /shazam-setup command
│
└── core/                               Pure analysis engine (zero dependencies)
    ├── treesitter.ts                   AST parsing + symbol extraction (6 languages)
    ├── treesitter-queries.ts           Tree-sitter query patterns
    ├── graph.ts                        Symbol dependency graph
    ├── pagerank.ts                     PageRank symbol importance scoring
    ├── scanner.ts                      Project file scanning + graph building
    ├── encoding.ts                     UTF-8 → GBK → GB2312 adaptive encoding
    ├── cache.ts                        Graph baseline save/diff + persistent cache
    ├── baseline.ts                     In-memory session baseline
    ├── filter.ts                       Shared file filtering (source vs config/generated)
    ├── output.ts                       Standardized tool output formatting
    ├── redact.ts                   Shared secret redaction
    ├── formatters.ts               Formatter/linter detection
    ├── audit-log.ts                Audit log rotation
    └── git-hooks.ts                    Git pre-commit hook management
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

| Language              | LSP Server                 | Status    |
| --------------------- | -------------------------- | --------- |
| TypeScript/JavaScript | typescript-language-server | Supported |
| Python                | pyright-langserver / pylsp | Supported |
| Go                    | gopls                      | Supported |
| Rust                  | rust-analyzer              | Supported |
| Dart (Flutter)        | dart language-server       | Supported |
| YAML                  | yaml-language-server       | Supported |
| JSON                  | vscode-json-languageserver | Supported |

When LSP servers are unavailable, tools automatically fall back to tree-sitter mode.

## License

MIT — see [LICENSE](LICENSE) file.
