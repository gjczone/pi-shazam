# pi-shazam MCP Server

Exposes pi-shazam's codebase analysis tools to any MCP-compatible AI client (Cursor, Claude Desktop, Windsurf, Qoder, etc.) via `npx pi-shazam-mcp`.

## Setup

### Cursor / Claude Desktop

Add to your MCP config (`~/.cursor/mcp.json` or `claude_desktop_config.json`):

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

### Qoder CLI

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

### Kimi Code

In VS Code, open Settings (Cmd+,) → search "Kimi Code" → MCP Servers → add a server with:

- Name: `pi-shazam`
- Command: `npx pi-shazam-mcp`

Or directly edit `kimi_mcp.json`:

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

### Specifying a project root

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

Defaults to the current working directory.

## Available Tools (9)

All tools use the `shazam_` prefix for consistency with the Pi extension.

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `shazam_overview`      | Project structure, top files (hotspots), dependencies, recent git changes, routes    |
| `shazam_lookup`        | Unified symbol/file lookup: definition, type signature, docs, hierarchy, file detail |
| `shazam_impact`        | File impact analysis + call chain tracing (--symbol param)                           |
| `shazam_verify`        | Post-edit verification (LSP diagnostics + codeAction fixes + graph)                  |
| `shazam_changes`       | Git change summary with risk level                                                   |
| `shazam_format`        | Auto-fix format/lint errors (prettier, eslint, biome, ruff, cargo fmt, gofmt)        |
| `shazam_find_tests`    | Discover test files for a module                                                     |
| `shazam_rename_symbol` | Safe project-wide symbol rename with reference verification                          |
| `shazam_safe_delete`   | Safe symbol deletion with reference check                                            |

## Architecture

```
mcp/entry.ts (MCP server)
    ↓
mcp/tools.ts (MCP tool wrappers)
    ↓
core/ + lsp/ (shared analysis engines)
```

The MCP server shares the same `core/` and `lsp/` layers as the Pi extension. No duplication.

## Language Support

- **Parsing (tree-sitter):** 6 languages — Python, TypeScript/TSX, JavaScript/JSX, Go, Rust, JSON
- **LSP (didOpen):** 6 languages — Python, TypeScript, JavaScript, Go, Rust, JSON

> **Design note:** pi-shazam supports 6 languages with both tree-sitter parsing and LSP diagnostics. The 6 languages are Python, TypeScript, JavaScript, Go, Rust, and JSON. These were selected for having well-tested, reliable language server coverage. YAML LSP support is available but not counted in the core 6 because it is diagnostic-only (no tree-sitter symbol extraction). See `lsp/client.ts` `_detectLanguage` for the authoritative mapping.
