# LLM Review Guide

You are reviewing **pi-shazam**, a Pi coding agent native codebase awareness extension that provides 9 structural analysis tools powered by tree-sitter and LSP. This guide focuses your review on real bugs and reliability issues only.

## Project Context

- **What**: TypeScript ESM extension for Pi coding agent — 9 structural analysis tools (overview, lookup, impact, verify, changes, format, find_tests, rename_symbol, safe_delete)
- **Size**: 48 source modules, ~12K LOC, 51 test files
- **Runtime**: Node.js >= 18, ESM (NodeNext module resolution)
- **Dependencies**: tree-sitter 0.22.4 (pinned via overrides), vscode-jsonrpc, @modelcontextprotocol/sdk, typebox, zod, iconv-lite
- **Architecture**: 4-layer DAG — `hooks/` -> `tools/` -> `core/` + `lsp/` — with strict boundary enforcement (`core/` must not import from `tools/`, `hooks/`, or `lsp/`)
- **State**: Module-level caches (scanner, LSP enrich, graph) with TTL and invalidation; session-scoped state (verify, impact, rename) with lifecycle management
- **External processes**: LSP servers spawned as child processes with timeout guards, JSON-RPC communication over stdin/stdout
- **Concurrency model**: Async/await with Promise.race for timeouts; LSP requests are serialized per server but multiple servers may run concurrently
- **Output contract**: All tool output goes to LLM context — format, truncation, and noise directly affect agent behavior

## Review Rules

### P0 — Must Fix

- **Logic errors**: Incorrect graph traversal, wrong PageRank computation, faulty symbol resolution, off-by-one in truncation
- **Type safety holes**: Unsafe `as` casts, missing null checks on optional chaining, `any` leaking through public interfaces
- **Concurrency bugs**: Race conditions in async/LSP calls, unhandled promise rejections, missing cleanup on abort
- **Resource leaks**: LSP child processes not killed on timeout, timers not cleared, file handles not closed
- **Security**: Path traversal in file operations, command injection in shell invocations, unsafe deserialization
- **Data corruption**: Stale cache entries served after invalidation, graph state inconsistency, serialization round-trip failures

### P1 — Reliability

- **Missing error handling**: Empty catch blocks, swallowed errors, missing try/catch on external calls
- **Silent failures**: Tools returning empty results without indication, LSP degradation not annotated
- **Inconsistent state**: TTL expiry race, session state not cleaned on error paths, verify/impact state leaking between calls
- **LLM-facing tool descriptions**: Incorrect parameter docs, missing usage examples, misleading trigger descriptions
- **Settings/precedence**: Config override order, `.pi/` vs `package.json` vs environment variables
- **Edge cases**: Empty input arrays, MAX_FILES truncation boundaries, zero-symbol projects, missing `node_modules`
- **Performance**: O(n^2) in hot paths (graph building, symbol lookup), unbounded memory growth, redundant file reads

### DO NOT Report

- Code style or formatting preferences
- Rename suggestions or naming conventions
- Test coverage percentage
- Dependency version updates (unless they fix a bug)
- Linting suggestions or unused variable warnings
- TypeScript strictness settings or type narrowing preferences
- Missing documentation or JSDoc comments
- Architecture opinions or structural refactoring ideas

## Key Files

### Tier 1 — Core Logic (highest blast radius)

| File | Responsibility |
|------|---------------|
| `core/scanner.ts` | Project scanning, file discovery, `getEffectiveRoot()` |
| `core/graph.ts` | Dependency graph construction, edge resolution |
| `core/treesitter.ts` | Language support, symbol extraction, AST queries |
| `core/pagerank.ts` | PageRank computation, file importance ranking |
| `tools/_factory.ts` | Tool registration factory, parameter validation, content envelope |
| `tools/lookup.ts` | Unified symbol/file lookup with hover info |
| `tools/impact.ts` | Blast radius analysis, caller/callee tracing |
| `tools/verify.ts` | Post-edit verification gate, LSP diagnostics integration |

### Tier 2 — State & Recovery

| File | Responsibility |
|------|---------------|
| `hooks/verify-state.ts` | Verify session state, TTL management |
| `hooks/impact-state.ts` | Impact analysis session state |
| `hooks/rename-state.ts` | Rename operation state tracking |
| `core/cache.ts` | Module-level cache with TTL and invalidation |
| `core/baseline.ts` | Git baseline tracking for change detection |
| `lsp/manager.ts` | LSP server lifecycle, process management |

### Tier 3 — Infrastructure

| File | Responsibility |
|------|---------------|
| `lsp/client.ts` | JSON-RPC communication, Content-Length framing |
| `mcp/entry.ts` | MCP server entry point, stdio transport |
| `mcp/tools.ts` | MCP tool definitions (Zod schemas, must match Pi tools) |
| `hooks/safety.ts` | Safety guards, rate limiting |
| `hooks/pre-edit.ts` | Pre-edit validation, file lock checks |

### Tier 4 — Entry & Commands

| File | Responsibility |
|------|---------------|
| `index.ts` | Extension entry, all registrations |
| `tools/overview.ts` | Project overview tool |
| `tools/format.ts` | Formatting tool |
| `hooks/before-start.ts` | Before-start lifecycle hook |

## How to Submit Findings

Use this format for each finding:

```markdown
### [P0/P1] Short title

**File**: `path/to/file.ts:123`
**Symptom**: What goes wrong (observable behavior)
**Root cause**: Why it goes wrong (code-level explanation)
**Fix**: Minimal change to resolve the issue
**Risk**: What breaks if unfixed
```

- One finding per section
- Include file path and line number
- Describe observable symptom, not just code smell
- Propose a concrete fix, not just a direction
- Rate severity honestly — P0 for correctness/security, P1 for reliability/edge cases

## Quick Sanity Checklist

Run these before submitting your review:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` produces `dist/index.js` and `dist/index.d.ts`
- [ ] `npm test` — all tests pass
- [ ] `grep -r "TODO\|FIXME\|HACK\|XXX" core/ tools/ hooks/ lsp/` — any leftover markers?
- [ ] `npx vitest run tests/definitions-parity.test.ts` — Pi/MCP tool definitions in sync
- [ ] `npx vitest run tests/data-integrity.test.ts` — data integrity checks pass
- [ ] `npx vitest run tests/path-containment.test.ts` — path traversal prevention verified
- [ ] `npx vitest run tests/benchmark.test.ts` — performance within thresholds