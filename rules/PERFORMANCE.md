# Performance Rules

Performance constraints and optimization guidelines for pi-shazam.

## Benchmark Thresholds

These are hard limits enforced by the benchmark test suite (`tests/benchmark.test.ts`). Regressions past these thresholds fail CI.

| Operation | Threshold | Input size |
|-----------|-----------|------------|
| `scanProject` | < 30 seconds | 100 files |
| PageRank computation | < 10 seconds | 1000 nodes |
| Graph building | < 5 seconds | 1000 nodes |

If a change causes a benchmark to exceed its threshold, the change must be optimized or redesigned before merging.

## PageRank

- **Complexity**: O(n * iterations) where n is the number of nodes in the dependency graph.
- **Location**: `core/pagerank.ts`
- **1000 nodes < 10s**: This is the benchmark threshold. Do not add O(n^2) operations to the PageRank hot path.
- **No logging in iteration loop**: PageRank iterations must not emit log output. A single log per PageRank invocation (start/finish) is acceptable.
- **Damping factor**: Standard 0.85. Do not change without benchmarking — it affects convergence speed.

## Graph Building

- **Location**: `core/graph.ts`
- **Indexed lookups**: All symbol resolution uses Map-based lookups, not linear scans. When adding new resolution logic, use the existing Map indexes.
- **No nested loops over all symbols**: If you need to correlate symbols across files, build an index first, then look up. Do not iterate all symbols for each symbol.
- **Graph construction is a one-time cost** per tool invocation. It does not need to be incremental — rebuild from the scan result each time.

## Project Scanning

- **Location**: `core/scanner.ts`
- **MAX_FILES = 20,000**: Hard cap on the number of files scanned. This prevents runaway scans on monorepos.
- **Incremental scanning**: Uses mtime-based cache stored in `~/.cache/repomap/`. Only files with changed modification times are re-parsed. Do not disable this.
- **File filtering**: Excluded directories (node_modules, .git, dist, build, __pycache__) are skipped during the walk. When adding a new directory to skip, update the exclusion list in `core/scanner.ts`.
- **Parallel reads**: File reading is sequential by default. If you add parallel reads, respect the MAX_FILES cap and watch for EMFILE errors.

## LSP Timeouts

- **Location**: `lsp/servers.ts`
- **DEFAULT_LSP_TIMEOUT_MS**: Base timeout for LSP requests. Configurable per language server.
- **DEFAULT_LSP_ENRICH_TIMEOUT_MS = 5000**: Timeout for LSP enrichment calls (document symbols, references, diagnostics).
- **FIRST_ENRICH_TIMEOUT_MS = 10,000**: Higher timeout for the first enrichment call per file (server may be initializing).
- **Overall 15s init guard**: If a language server does not respond to `initialize` within 15 seconds, it is killed and the session degrades to tree-sitter only.
- **Never block indefinitely**: All LSP calls must have a timeout. If a new LSP call is added without a timeout, it will hang the tool invocation.

## Tool Output Truncation

- **Location**: `core/output.ts`
- **`truncateOutput(text, maxTokens)`**: Truncates tool output to fit within the token budget. Used by all tools when `maxTokens` is specified.
- **`estimateTokens(text)`**: Estimates token count from text length. Used for size management before returning output.
- **Truncation is explicit**: When output is truncated, the tool must append `"... and N more"` to indicate missing content. Do not silently drop content.

## Encoding

- **Location**: `core/encoding.ts`
- **`readFileAdaptive(path)`**: Reads a file trying UTF-8 first (fast path). Falls back to GBK and GB2312 only on UTF-8 decode failure.
- **UTF-8 is the common case**: The vast majority of source files are UTF-8. The GBK/GB2312 fallback is for legacy Chinese-encoded files. Do not change the fallback order.
- **No BOM handling overhead**: The reader does not strip BOM markers. If BOM handling is needed, add it only to the encoding fallback path, not the UTF-8 fast path.

## Tree-Sitter

- **Grammar loading**: Each grammar is loaded once per language and reused across all parses in the session. Do not reload grammars on each parse call.
- **Location**: `core/treesitter.ts`
- **Query caching**: tree-sitter Query objects are created once and reused. Do not recreate queries in loops.
- **Parse vs. query**: Parsing is relatively cheap. Query evaluation (especially captures on large files) is the expensive part. When optimizing, focus on query efficiency, not parse frequency.

## Hot-Path Restrictions

The following code paths are performance-critical. Do not add logging, I/O, or expensive operations to them:

1. **PageRank iteration loop** (`core/pagerank.ts`) — no logging, no file I/O
2. **Graph traversal** (`core/graph.ts`) — no logging during BFS/DFS
3. **File scanning walk** (`core/scanner.ts`) — no logging per file, only aggregate summary
4. **Tree-sitter query evaluation** (`core/treesitter.ts`) — no logging per capture
5. **Token estimation** (`core/output.ts`) — pure arithmetic, no I/O

Logging at the start and end of these operations is acceptable. Logging inside the loop body is not.

## Caching Strategy

- **File cache**: `~/.cache/repomap/` stores mtime-indexed scan results. Invalidate by mtime change.
- **Grammar cache**: In-memory, per-session. No persistence needed.
- **LSP server cache**: One server process per language per session. Managed by `lsp/manager.ts`.
- **No unbounded caches**: Every cache must have an eviction strategy or size cap. If you add a new cache, document its lifecycle and size limit.
