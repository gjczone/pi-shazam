# DEBUGGING.md — pi-shazam Debugging Guide

## Tree-Sitter Issues

### Grammar Version Mismatch

Symptoms: parse failures, `Language is not a constructor`, missing symbols from specific languages.

**Check grammar versions in `package.json`:**

```bash
cat package.json | grep tree-sitter-
```

All grammar packages must be compatible with `tree-sitter@^0.22.4` (pinned via `overrides`). If a grammar requires a newer tree-sitter version, it will fail at load time with a cryptic native module error.

**Test parse on a single file:**

```ts
import Parser from "tree-sitter";
import { Language } from "tree-sitter";

const parser = new Parser();
const grammar = require("tree-sitter-typescript").typescript;
parser.setLanguage(new Language(grammar));
const tree = parser.parse("const x: number = 1;");
console.log(tree.rootNode.toString());
```

If this fails, the grammar package is broken or incompatible.

### EXT_TO_LANG Mapping

Symptoms: file extension not recognized, falls back to plaintext parsing.

**Check `core/treesitter.ts` → `EXT_TO_LANG` map:**

```ts
// If .tsx files aren't being parsed:
// 1. Verify ".tsx" exists in EXT_TO_LANG
// 2. Verify the grammar is imported and set in setLanguage()
// 3. Verify the tree-sitter query in treesitter-queries.ts has a TSX section
```

Each new language extension requires: entry in `EXT_TO_LANG`, grammar loaded in parser setup, and query patterns in `core/treesitter-queries.ts`.

### Query Failures

Symptoms: `query.captures()` throws, no symbols extracted from a file that parses correctly.

- Check query syntax in `core/treesitter-queries.ts` — tree-sitter query syntax varies slightly between language grammars.
- Run `query.captures(node)` on a known `SyntaxNode` to isolate whether the query or the node is the problem.
- Node.js tree-sitter uses `query.captures()`, not Python's `QueryCursor`.

## LSP Communication Errors

### JSON-RPC Framing

Symptoms: `Content-Length` mismatch, incomplete reads, server hangs during initialize.

The LSP client (`lsp/client.ts`) uses `vscode-jsonrpc` `StreamMessageReader` / `StreamMessageWriter` for framing. If you suspect framing issues:

1. **Check process stdio**: The LSP server child process must have `stdin`/`stdout` piped, `stderr` can go to `pipe` or `inherit`.
2. **Check Content-Length**: Each JSON-RPC message must have `Content-Length: <byte-count>\r\n\r\n<body>`. Byte count is for the UTF-8 encoded body, not the character count.
3. **Check incomplete reads**: If the server sends a partial message, `StreamMessageReader` buffers until the full frame arrives. If the server crashes mid-send, the reader will hang until timeout.

### Server Crash on Initialize

Symptoms: server process exits immediately after `initialize` request.

**Debug steps:**

1. Check `lsp/servers.ts` for the server command and args — is the binary installed? Does it support the `--stdio` flag?
2. Pipe server stderr to console: `child.stderr.on("data", d => console.error(d.toString()))`.
3. Check `InitializeParams` in `lsp/client.ts` — invalid `capabilities` or `rootUri` can crash servers.
4. Try running the server manually: `typescript-language-server --stdio` and send a raw `initialize` request.

### Timeout Guard

LSP initialization has a 15s overall timeout guard. If the server doesn't respond to `initialize` within 15s, the client aborts and falls back to tree-sitter only.

Per-language timeout overrides can be configured in `lsp/servers.ts`. Increase if the server is slow to start (e.g., Java language server loading a large classpath).

## Tool Not Appearing in Pi

Symptoms: LLM doesn't see the tool, `shazam_*` not listed in tool calls.

**Debug checklist:**

1. **Registration**: Verify `register<ToolName>(pi)` is called in `index.ts` default export function. If the import is missing, the tool is never registered.
2. **Build**: Run `npm run build` — stale `dist/` won't contain new tool definitions.
3. **Symlink**: Verify `~/.pi/agent/extensions/pi-shazam` points to the built `dist/` directory.
4. **Name conflict**: Check if another Pi extension already registers a tool with the same name. Prefix all tools with `shazam_` to avoid this.
5. **Pi logs**: Check Pi extension loading logs for import errors or registration failures.

## Extension Loading Failures

Symptoms: Pi doesn't load pi-shazam at all, no tools appear.

**Debug steps:**

1. **Build output**: Confirm `dist/index.js` and `dist/index.d.ts` exist after `npm run build`.
2. **Symlink**: Check that the symlink or extension config points to the correct path.
3. **Import errors**: If `dist/index.js` has import errors (missing modules, wrong paths), the extension will fail silently. Run `node dist/index.js` to check for runtime import failures.
4. **Type errors**: Run `npm run typecheck` — type errors don't prevent build but may indicate logic bugs.

## Encoding Issues

Symptoms: garbled text in tool output, `readFileAdaptive` returns mojibake, non-ASCII filenames fail.

**The encoding fallback chain**: `core/encoding.ts` → `readFileAdaptive(path)` tries UTF-8 first, then GBK, then GB2312.

**Debug steps:**

1. Check `iconv-lite` is installed: `ls node_modules/iconv-lite`.
2. Verify the file's actual encoding: `file --mime-encoding <path>`.
3. If the file is UTF-8 with BOM, `readFileAdaptive` handles it — BOM is stripped.
4. If the file is neither UTF-8, GBK, nor GB2312 (e.g., Shift-JIS, EUC-KR), the fallback chain will fail. Add the encoding to `core/encoding.ts` if needed.

## Cache Issues

Symptoms: tool returns stale data, changes to files not reflected in output.

**Cache location**: `~/.cache/repomap/` (XDG-compatible).

**Cache invalidation**: mtime-based. If a file's mtime hasn't changed, the cached result is used.

**Debug steps:**

1. **Check cache contents**: `ls ~/.cache/repomap/` — files are named by content hash.
2. **Force reset**: Call `resetCache()` from `core/cache.ts` to clear all cached data.
3. **mtime issues**: Some editors (Vim with backupcopy) or CI environments may not update mtime reliably. In that case, delete the cache directory manually.
4. **Cross-session**: Cache persists across sessions. A scan in session A is available in session B if mtimes match.

## MCP Issues

Symptoms: MCP tools not responding, Zod schema validation errors, content envelope mismatch.

### Entry Point

MCP server starts at `mcp/entry.ts` using stdio transport. Verify:

1. `mcp/entry.ts` is the entry point in the MCP server config.
2. The process receives input on stdin and writes responses to stdout.
3. stderr is for logging/debugging only, not JSON-RPC.

### Schema Parity

Pi tools use TypeBox for parameter schemas. MCP tools use Zod. These must stay in sync:

- `tools/definitions.ts` (TypeBox) ↔ `mcp/tools.ts` (Zod)
- Parameter names, types, and required/optional status must match.
- `definitions-parity.test.ts` enforces this — if it fails, a tool's parameters diverged.

### Content Envelope

MCP tools return: `{ content: [{ type: "text", text: string }] }`.

If the envelope is wrong, the MCP client won't display results. Check `mcp/tools.ts` tool handlers for the correct return format.

## Hook Debugging

Hooks (`hooks/*.ts`) subscribe to Pi lifecycle events and inject context into the LLM.

### Lifecycle Events

| Event | When | Common hooks |
|---|---|---|
| `before_agent_start` | Before LLM inference begins | `before-start.ts` |
| `tool_call` | Before a tool executes | `pre-edit.ts`, `safety.ts` |
| `tool_result` | After a tool returns | `impact-state.ts`, `rename-state.ts` |
| `turn_end` | After LLM turn completes | `verify-state.ts` |
| `session_shutdown` | Session ending | cleanup hooks |

### Debug Steps

1. **Event not firing**: Check `index.ts` — is the hook's `register*` function called? Hooks register via `pi.on("event_name", handler)`.
2. **Handler throwing**: Unhandled errors in hooks can silently break the extension. Wrap handlers in try/catch with `_logWarn`.
3. **State sharing**: `impact-state.ts`, `rename-state.ts`, `verify-state.ts` share state between hooks via module-level variables. If state is stale, check that the producing hook runs before the consuming hook.

## Session State Debugging

Shared state modules manage cross-hook coordination:

- **`verify-state.ts`**: Tracks verification status across tool calls within a session.
- **`impact-state.ts`**: Stores impact analysis results for consumption by later hooks.
- **`rename-state.ts`**: Tracks rename operations to prevent conflicting renames.

These modules use module-level `let` variables (not `const`). State resets when the extension is reloaded (new session). If state persists unexpectedly, the extension wasn't properly unloaded.

Check `rules/DATA-STATE.md` for full lifecycle and reset rules.

## Graph Issues

Symptoms: wrong PageRank scores, missing edges, `scanProject` returns incomplete graph.

### Serialization V2

`core/graph.ts` uses serialization V2 format. If you see deserialization errors, the cached graph was written with an older format. Call `resetCache()` to force re-scan.

### MAX_FILES Limit

`scanProject` caps at `MAX_FILES=20000` files. Projects exceeding this are silently truncated. If symbols are missing in a large project, check the scan result for truncation warnings.

### Debug the Graph

```ts
import { scanProject } from "../core/scanner.js";
import { buildDependencyGraph } from "../core/graph.js";

const scan = await scanProject(".");
const graph = buildDependencyGraph(scan);

console.log("Nodes:", graph.nodes.size);
console.log("Edges:", graph.edges.length);
console.log("Top PageRank:", graph.pageRank.slice(0, 10));
```

If `nodes.size` is 0, `scanProject` didn't find any parseable files — check the project root and file extensions.

### Common Graph Bugs

1. **Self-loops**: A symbol importing itself. `buildDependencyGraph` should filter these — if it doesn't, it's a bug.
2. **Missing cross-file edges**: Tree-sitter queries must extract import statements. Check `core/treesitter-queries.ts` for the relevant language.
3. **Orphan nodes**: Symbols with no edges. This is normal for entry points and utility functions, but suspicious for mid-graph nodes.

## Quick Diagnostic Commands

```bash
# Full type check
npm run typecheck

# Run all tests
npm test

# Run specific test file
npx vitest run tests/encoding.test.ts

# Run tests matching a pattern
npx vitest run -t "smoke"

# Build extension
npm run build

# Verify dist output
ls -la dist/index.js dist/index.d.ts

# Check extension symlink
ls -la ~/.pi/agent/extensions/pi-shazam

# Inspect cache
ls ~/.cache/repomap/

# Clear cache
rm -rf ~/.cache/repomap/

# Check tree-sitter grammars
node -e "const p = require('tree-sitter-typescript'); console.log(typeof p.typescript)"

# Check LSP server availability
which typescript-language-server
which pyright
```
