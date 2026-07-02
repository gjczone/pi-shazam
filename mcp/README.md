# pi-shazam MCP Server

Exposes pi-shazam's codebase analysis tools to any MCP-compatible AI client via `npx pi-shazam-mcp`.

## Setup

Add the following to your MCP client's server configuration. Replace `/path/to/project` with your project root (or omit it to use the current working directory). On Windows, use forward slashes or escape backslashes (e.g., `C:/Users/<username>/projects/my-project` or `C:\\Users\\<username>\\projects\\my-project`).

### CodeBuddy

Config file: `mcp.json`

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

### Kimi Code

Config file: `kimi_mcp.json`

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

### Qwen Code

Config file: `mcp.json`

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

### Claude

Config file: `claude_desktop_config.json`

**Linux/macOS:**

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

**Windows (cmd / PowerShell / Git Bash):**

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "C:/Users/<username>/projects/my-project"]
		}
	}
}
```

On Windows, use forward slashes (`C:/Users/...`) or escape backslashes (`C:\\Users\\...`) in JSON config. All Windows shells (cmd, PowerShell 5/7, Git Bash) are supported.

### Codex

Config file: `mcp.json`

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

### Qoder

Config file: `mcp.json`

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

### Trae

Config file: `mcp.json`

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp", "/path/to/project"]
		}
	}
}
```

## Available Tools (7)

All tools use the `shazam_` prefix for consistency with the Pi extension.

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `shazam_overview`      | Project structure, top files (hotspots), dependencies, recent git changes, routes    |
| `shazam_lookup`        | Unified symbol/file lookup: definition, type signature, docs, hierarchy, file detail |
| `shazam_impact`        | File impact analysis + call chain tracing (--symbol param)                           |
| `shazam_verify`        | Post-edit verification (LSP diagnostics + codeAction fixes + graph)                  |
| `shazam_changes`       | Git change summary with risk level                                                   |
| `shazam_format`        | Auto-fix format/lint errors (prettier, eslint, biome, ruff, cargo fmt, gofmt)        |
| `shazam_rename_symbol` | Safe project-wide symbol rename with reference verification                          |

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

- **Parsing (tree-sitter):** 8 file extensions (7 grammars) — Python, TypeScript/TSX, JavaScript/JSX, Go, Rust, Dart, JSON
- **LSP (didOpen):** 7 language servers — Python (pyright), TypeScript/JavaScript (typescript-language-server), Go (gopls), Rust (rust-analyzer), JSON (vscode-json), YAML (yaml-language-server, diagnostic-only), Dart

> **Design note:** pi-shazam parses 8 file extensions (Python, TypeScript/TSX, JavaScript/JSX, Go, Rust, Dart, JSON) via 7 tree-sitter grammars and provides LSP diagnostics for all of them plus YAML. See `lsp/client.ts` `_detectLanguage` for the authoritative mapping.
