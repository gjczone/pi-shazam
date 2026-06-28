# pi-shazam

Codebase awareness toolkit for the Pi coding agent — 9 structural analysis tools powered by tree-sitter and LSP that give your agent deep understanding of any project.

## Installation

Two ways to use pi-shazam, depending on your agent:

### Native Extension — Pi Coding Agent only

For the [Pi coding agent](https://github.com/gjczone/pi-coding-agent). Installs as a first-class extension — tools appear alongside `read`/`write`/`bash` with no distinction.

```bash
pi install npm:pi-shazam
```

### MCP Server — all other AI agents

For Kimi Code, CodeBuddy, Qwen Code, Claude, Codex, Qoder, Trae, and any MCP-compatible client.

```json
{
	"mcpServers": {
		"pi-shazam": {
			"command": "npx",
			"args": ["-y", "-p", "pi-shazam@latest", "pi-shazam-mcp"]
		}
	}
}
```

## Analysis Tools

| Tool                   | When to use                                | What it does                                                                          |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `shazam_overview`      | First entry, need project structure        | Project summary: top files, dependencies, hotspots, entry points, key data structures |
| `shazam_lookup`        | Need symbol details or concept search      | Unified lookup + fuzzy concept search ("how is X implemented")                        |
| `shazam_impact`        | Before editing shared or exported modules  | Blast radius analysis — every file, symbol, and test affected by a change             |
| `shazam_verify`        | After every write or edit                  | Post-edit verification: LSP diagnostics, graph analysis, PASS/WARN/FAIL               |
| `shazam_changes`       | After edits to see what changed            | Git change summary with symbol-level detail, risk level, affected callers             |
| `shazam_format`        | When `shazam_verify` reports format errors | Auto-fix formatting (prettier, biome, eslint, ruff, cargo fmt, gofmt)                 |
| `shazam_rename_symbol` | Before renaming any symbol                 | LSP cross-file symbol rename with atomic writes                                       |
| `shazam_safe_delete`   | Before removing any symbol                 | Read-only check for zero incoming references before deletion                          |

## Slash Commands

Setup and hook installation run automatically on session start. No manual commands needed.

| Command                     | When                 | Purpose                                                              |
| --------------------------- | -------------------- | -------------------------------------------------------------------- |
| `/shazam-setup`             | Automatic (on start) | Detect and report LSP server availability with install instructions  |
| `/shazam-install-git-hooks` | Automatic (on start) | Install git pre-commit hook that runs `shazam_verify`                |
| `/shazam-doctor`            | When troubleshooting | Health check: tree-sitter grammars, LSP servers, cache integrity     |
| `/shazam-remove-git-hooks`  | When uninstalling    | Remove the shazam git pre-commit hook                                |
| `/shazam-pre-commit-verify` | Automatic (by hook)  | Run pre-commit verification (called by git hook; not for manual use) |

## Supported Languages

| Language   | Tree-sitter | LSP                         |
| ---------- | ----------- | --------------------------- |
| Python     | Yes         | pyright / pylsp             |
| TypeScript | Yes         | typescript-language-server  |
| JavaScript | Yes         | typescript-language-server  |
| Go         | Yes         | gopls                       |
| Rust       | Yes         | rust-analyzer               |
| Dart       | Yes         | dart language-server        |
| JSON       | Yes         | vscode-json-language-server |
| YAML       | -           | yaml-language-server        |

## Platform Support

| Platform | Status                                      |
| -------- | ------------------------------------------- |
| Linux    | Supported                                   |
| macOS    | Supported                                   |
| Windows  | Not supported (tree-sitter native bindings) |

## License

[MIT](LICENSE)
