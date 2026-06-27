# pi-shazam

Codebase awareness toolkit for the Pi coding agent — 9 structural analysis tools powered by tree-sitter and LSP that give your agent deep understanding of any project.

## Installation

### Pi install (recommended)

```bash
pi install npm:pi-shazam
```

### MCP (CodeBuddy, Kimi Code, Qwen Code, Claude, Codex, Qoder, Trae, etc.)

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

| Tool                   | When to use                                | What it does                                                              |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `shazam_overview`      | First entry, need project structure        | Project summary: top files by PageRank, dependencies, complexity hotspots |
| `shazam_lookup`        | Need symbol or file details                | Unified lookup with hover info, type hierarchy, callers and callees       |
| `shazam_impact`        | Before editing shared or exported modules  | Blast radius analysis — every file, symbol, and test affected by a change |
| `shazam_verify`        | After every write or edit                  | Post-edit verification: LSP diagnostics, graph analysis, PASS/WARN/FAIL   |
| `shazam_changes`       | After edits to see what changed            | Git change summary with symbol-level detail, risk level, affected callers |
| `shazam_format`        | When `shazam_verify` reports format errors | Auto-fix formatting (prettier, biome, eslint, ruff, cargo fmt, gofmt)     |
| `shazam_find_tests`    | Adding tests or modifying source           | Discover test files, test functions, and where new tests belong           |
| `shazam_rename_symbol` | Before renaming any symbol                 | LSP cross-file symbol rename with atomic writes                           |
| `shazam_safe_delete`   | Before removing any symbol                 | Read-only check for zero incoming references before deletion              |

## Slash Commands

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `/shazam-setup`             | Detect and report LSP server availability with install instructions |
| `/shazam-doctor`            | Health check: tree-sitter grammars, LSP servers, cache integrity    |
| `/shazam-install-git-hooks` | Install git pre-commit hook that runs `shazam_verify`               |
| `/shazam-remove-git-hooks`  | Remove the shazam git pre-commit hook                               |
| `/shazam-pre-commit-verify` | Run pre-commit verification (used by git hook)                      |

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

## Contributing

Development guide: [AGENTS.md](./AGENTS.md), release: `bash scripts/release.sh`.
