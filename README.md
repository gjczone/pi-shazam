# pi-shazam

Codebase awareness toolkit for the Pi coding agent — 7 structural analysis tools powered by tree-sitter and LSP that give your agent deep understanding of any project.

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

| Tool                   | When to use                                | What it does                                                                                                      |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `shazam_overview`      | First entry, need project structure        | Project summary: top files, dependencies, hotspots, entry points, key data structures                             |
| `shazam_lookup`        | Need symbol details or concept search      | Unified lookup + fuzzy concept search ("how is X implemented")                                                    |
| `shazam_impact`        | Before editing shared or exported modules  | Blast radius analysis — every file, symbol, and test affected by a change                                         |
| `shazam_verify`        | After every write or edit                  | Post-edit verification: LSP diagnostics with auto-detection of unreliable servers, graph analysis, PASS/WARN/FAIL |
| `shazam_changes`       | After edits to see what changed            | Git change summary with symbol-level detail, risk level, affected callers                                         |
| `shazam_format`        | When `shazam_verify` reports format errors | Auto-fix formatting (prettier, biome, eslint, ruff, cargo fmt, gofmt)                                             |
| `shazam_rename_symbol` | Before renaming any symbol                 | LSP cross-file symbol rename with atomic writes                                                                   |

## Slash Commands

Setup and hook installation run automatically on session start. No manual setup commands needed.

| Command          | When                 | Purpose                                                            |
| ---------------- | -------------------- | ------------------------------------------------------------------ |
| `/shazam-doctor` | When troubleshooting | Health check: LSP status, recent errors, slow calls, safety status |

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

| Platform | Status                                    |
| -------- | ----------------------------------------- |
| Linux    | Supported                                 |
| macOS    | Supported                                 |
| Windows  | Supported (cmd, PowerShell 5/7, Git Bash) |

All tree-sitter grammars ship prebuilt binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, and win32-arm64. No C++ compiler required on any platform.

On Windows, `npm run build` works in any shell. `bash scripts/ci.sh` requires Git Bash (bundled with Git for Windows).

## License

[MIT](LICENSE)
