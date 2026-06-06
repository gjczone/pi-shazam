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

## Available Tools (13)

All tools use the `shazam_` prefix for consistency with the Pi extension.

| Tool | Description |
|------|-------------|
| `shazam_overview` | Project structure, top files, dependencies, recent git changes, routes |
| `shazam_impact` | Blast radius analysis before multi-file edits |
| `shazam_codesearch` | BM25 symbol search (use instead of grep) |
| `shazam_symbol` | Symbol lookup with definition, callers, callees, state map |
| `shazam_file_detail` | File structural analysis (symbols, PageRank, hierarchy) |
| `shazam_call_chain` | Upstream callers and downstream callees |
| `shazam_hover` | Type signatures and documentation via LSP |
| `shazam_find_tests` | Discover test files for a module |
| `shazam_hotspots` | Complexity hotspots ranked by blast radius |
| `shazam_verify` | Post-edit verification (LSP diagnostics + graph analysis) |
| `shazam_type_hierarchy` | Class/interface inheritance chain |
| `shazam_rename_symbol` | Safe symbol rename with reference verification |
| `shazam_safe_delete` | Safe symbol deletion with reference check |

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

- Parsing: 18 languages (tree-sitter)
- LSP: 6 languages (TypeScript, Python, Rust, Go, JSON, YAML)

When LSP servers are unavailable, tools fall back to tree-sitter only.
