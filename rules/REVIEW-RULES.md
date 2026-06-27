# REVIEW-RULES.md for pi-shazam

You are reviewing **pi-shazam**, a Pi coding agent native codebase awareness toolkit that unifies tree-sitter parsing, LSP protocol communication, and PageRank-based dependency analysis into a set of agent-callable tools. This guide focuses your review on real bugs and reliability issues only.

## Project Context

- **What it is**: TypeScript/Node.js Pi extension providing 9 structural analysis tools (overview, lookup, impact, verify, changes, format, find_tests, rename_symbol, safe_delete) plus 11 lifecycle hooks and 2 MCP tools.
- **Size**: 48 TypeScript source files across 5 directories (core/, tools/, hooks/, lsp/, mcp/) + 50+ vitest test files. Approaching the "Mature" stage.
- **Runtime**: Node.js >= 18, ESM modules, runs as a Pi extension loaded into the Pi coding agent process.
- **Dependencies**: tree-sitter (multi-language parsing), vscode-jsonrpc + vscode-languageserver-protocol (LSP JSON-RPC), iconv-lite (UTF-8/GBK encoding fallback), @modelcontextprotocol/sdk (MCP server), typebox (tool parameter schemas), zod (MCP validation).
- **Key architecture facts**:
  - Strict 4-layer dependency: `hooks/` → `tools/` → `core/` + `lsp/`. `core/` has zero Pi or LSP imports. Layer violations are not caught by tsc; manual verification required.
  - Module-level mutable state: `cachedGraph`, `_projectRootOverride`, `_scanning` mutex, `_rpcModule`, `_notifications`. All are reset on `session_shutdown`. Concurrent access is guarded by a re-entrancy mutex (`_scanning` flag), not async locks.
  - Tools register via a factory (`tools/_factory.ts`) that auto-injects `json`/`maxTokens` params, scans the project graph, and wraps output in a standardized envelope. Tools with complex async LSP logic use `customExecute` which bypasses auto-scan.

## Review Rules

### DO report these (P0 -- must fix)

1. **Layer boundary violations**: A `core/` file importing from `tools/`, `hooks/`, or `lsp/`; a `lsp/` file importing from `tools/` or `hooks/`; a `tools/` file importing from `hooks/`.
2. **Type safety holes**: `as` casts that suppress type errors, `any` usage that bypasses the graph data model, missing null checks on `Map.get()` results where the key may not exist.
3. **Stale graph state bugs**: Code paths that mutate `RepoGraph` maps without updating all related indexes (`nameIndex`, `targetToSources`, `incoming`, `outgoing`). Also: code that reads `cachedGraph` after a scan failure without checking for null.
4. **Re-entrancy / concurrency hazards**: Calls to `scanProject()` inside a tool execute path that could be re-entered (the `_scanning` mutex throws on re-entry, but the throw may be swallowed). Async operations on `cachedGraph` without the mutex held.
5. **Resource leaks**: LSP child processes not shut down on `session_shutdown`, timer handles not cleared (e.g., `setTimeout` in `withTimeout`), event listeners not removed on `AbortSignal`.
6. **Path traversal / security**: Input file paths not validated against project root (use `validatePathInProject` from `_factory.ts`). Symlink escapes not caught by `realpathSync` check. Commands injected via tool parameters that reach `execSync` or `spawn`.
7. **Data corruption on graph serialization**: `deserializeGraphV2` missing null-guards on cache fields (validated in `data-integrity.test.ts`). Edge deduplication not applied during deserialization. NameIndex not rebuilt after deserialization.
8. **Empty catch blocks**: Any `catch` that silently swallows an error without logging via `_logWarn` or propagating. Especially in LSP request methods, scanner file reads, and hook event handlers.
9. **Encoding boundary bugs**: UTF-8 detection failing when a multi-byte character straddles the 64KB validation chunk boundary (tested in `encoding-boundary.test.ts`). GBK/GB2312 fallback returning garbled text for valid UTF-8 files.
10. **MAX_FILES truncation without warning**: `collectSourceFiles` sets `truncated=true` but if the caller ignores it, the graph is silently incomplete (fixed in #471-A, regression check).

### DO report these (P1 -- reliability risk)

1. **Missing error handling in LSP request methods**: `definition`, `references`, `hover`, etc. return `LspResult` but callers may not check `status === "error"` before accessing `.data`.
2. **Silent failures**: `parseFile` in scanner catches errors and returns null -- if the error is not `FileTooLargeError`, the file is silently skipped. Missing symbols may cascade into incorrect impact analysis.
3. **Inconsistent project root**: `process.cwd()` vs `getEffectiveRoot()` vs `_projectRootOverride`. Code that uses `process.cwd()` directly instead of `getEffectiveRoot()` will break when Pi is launched from a parent directory.
4. **Tool description drift**: Pi tool descriptions in `tools/*.ts` not matching MCP tool descriptions in `mcp/tools.ts`. Also: tool descriptions that suggest parameters or behavior the tool does not support.
5. **Notification cap eviction correctness**: `_notifications` Map in `LspClient` is capped at 2000 entries with oldest-first eviction. Eviction preserves insertion order but may drop diagnostics for files that were opened early and never re-saved during a long session.
6. **Token budget truncation**: `truncateOutput` uses 4 chars/token heuristic. If a tool's output contains dense CJK text or very long lines, the heuristic may underestimate and exceed the Pi runtime's actual token budget.
7. **Edge cases in incremental scan**: `scanIncremental` builds `dependentFiles` from `findDependentFiles` but also adds cross-file call edges via `oldIncomingBySymId` snapshot. If the snapshot is stale (graph mutated between snapshot and rebuild), dependent files may be missed.

### DO NOT report these (ignore -- not useful)

- Code style, formatting, variable naming, line length, JSDoc completeness.
- Rename suggestions, function-split suggestions -- unless there is a concrete bug caused by the structure.
- Test coverage percentages, missing test categories.
- Dependency version suggestions (unless there is a known CVE).
- Linting-level suggestions (`const` vs `let`, `===` vs `==`).
- TypeScript strictness flags.
- Missing docs, missing comments -- the project manages docs separately.
- Architecture opinions ("use class instead of interface").
- Feature suggestions not currently implemented.

## Key Files to Review

### Tier 1 -- Core Logic (highest risk)

| File                | What to check                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/scanner.ts`   | `scanProject` / `scanIncremental` / `scanFull`: stale index bugs in `removeFileData` and `removeEdgesForFile` (4 index maps must stay consistent). `findDependentFiles` reverse index correctness. `_projectRootOverride` not propagated to all scan paths. `_scanning` mutex not reset on exception (the `finally` block should handle it -- verify). |
| `core/graph.ts`     | `deserializeGraphV2`: null-guard on every cache field; dangling edge skip with `_logWarn`. `compareGraphSnapshots`: edge identity includes weight/confidence; stable-key reconciliation correctness. `nameIndex` rebuild after deserialization must match `scanFull` behavior.                                                                         |
| `lsp/client.ts`     | `withTimeout`: timer cleanup in all paths (resolve, reject, cancel). `_sendRequest`: `CancellationTokenSource` disposed in finally; external token listener removed. `_notifications` cap eviction: oldest-first is correct but verify it does not evict the most recently updated entry. `_cleanupAfterCrash` idempotency (the `_cleanedUp` latch).   |
| `tools/_factory.ts` | `validatePathInProject`: `realpathSync` is called but the resolved real path is not returned -- callers must re-resolve. `createTool`: error path in `execute` callback -- when `domainFn` throws and `json=false`, the error is returned as `isError: true` but not logged via `_logWarn`.                                                            |

### Tier 2 -- State & Recovery

| File              | What to check                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/cache.ts`   | `saveGraphCache`: serialization must be atomic (no partial writes). `loadGraphCache`: corrupted JSON must not crash -- the try/catch around `JSON.parse` should catch all parse errors. Version mismatch handling (currently only v2 supported).                                                            |
| `lsp/manager.ts`  | `initializeAll`: timeout guard via `Promise.race` -- verify cleanup on timeout (orphaned processes). `shutdown`: all clients shut down in parallel; verify no unhandled rejection if one client fails. `detectLanguages`: file walk uses `readdirSync` -- verify skip-dir logic for `node_modules`, `.git`. |
| `hooks/safety.ts` | Destructive command patterns: regex coverage for bypass variants (extra spaces, tabs, split flags). `tokenizeSegments`: chained command parsing (e.g., `echo safe && git commit`). Pre-commit gate: `hasRecentPassingVerify` timer -- verify the 5-minute window is not too short/long.                     |
| `core/output.ts`  | `_logWarn`: ENOENT suppression is correct but verify other expected error codes (EACCES, EPERM) are NOT suppressed. `truncateOutput`: high-priority line detection by prefix -- verify important detail lines starting with `- ` are not dropped.                                                           |

### Tier 3 -- Tools & Entry Points

| File              | What to check                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | Registration order: `before_agent_start` handler must be registered before `registerBeforeStartHook`. LSP init timeout handler: verify `lspManager.shutdown()` is called on timeout but does not throw into the catch path. `session_shutdown`: cache reset order -- scanner cache then LSP enrich state; verify both are guarded by try/catch. |
| `tools/impact.ts` | Call chain traversal: edge weight and confidence thresholds. Cycle detection -- verify infinite loops in circular dependencies are prevented. Output truncation -- verify the token budget is respected.                                                                                                                                        |
| `tools/verify.ts` | Orphan detection: symbols with zero incoming edges. Verification categories (type errors, new orphans, lint) -- verify each category is independently computed and failures in one category do not suppress others.                                                                                                                             |
| `mcp/tools.ts`    | Pi-MCP sync: every Pi tool must have a matching MCP registration with same name prefix, description, and parameter schema. Zod schemas must match typebox schemas in the corresponding `tools/*.ts` file.                                                                                                                                       |

### Tests -- Reference only

| File                              | What to check                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/data-integrity.test.ts`    | Verifies #471 fixes (Finding A: MAX_FILES truncation, B: cache null guards, C: targetToSources cleanup). Cross-check: if scanner/graph change, these tests must still pass. |
| `tests/factory.test.ts`           | Verifies `createTool` factory behavior including #464 project root override. Cross-check: if factory signature changes, update mockPi expectations.                         |
| `tests/encoding-boundary.test.ts` | Verifies UTF-8 detection at 64KB chunk boundary. Cross-check: if `readFileAdaptive` or `VALIDATION_CHUNK_SIZE` changes, the boundary test must be updated.                  |

## How to Submit Findings

```
### [P0|P1] Short title

**File**: `path/to/file.ts:line`

**Problem**: Describe the bug or reliability risk in 2-3 sentences.

**Impact**: What actually goes wrong? When would it happen?

**Fix**: Suggest the minimal code change.
```

Skip any finding that does not meet the P0/P1 bar. Do not submit more than 15 findings total -- prioritize the most impactful ones.

## Quick Sanity Checklist

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` produces `dist/index.js` and `dist/index.d.ts`
- [ ] `npm test` -- all tests pass, 0 failures
- [ ] `grep -r "TODO\|FIXME\|HACK\|XXX" core/ tools/ hooks/ lsp/ --include="*.ts"` -- any leftover markers?
- [ ] `grep -r "console\.\(log\|error\)" core/ tools/ hooks/ lsp/ --include="*.ts"` -- are there debug logs that should use `_logWarn`? (Exclude `_logWarn`'s own `console.warn`)
- [ ] `grep -rn "as " core/ lsp/ --include="*.ts" | grep -v "as const\|as string\|as number\|as never\|as unknown"` -- any unsafe type casts?
- [ ] Verify no `core/` file imports from `tools/`, `hooks/`, or `lsp/`: `grep -rn "from '\.\.\/tools\|from '\.\.\/hooks\|from '\.\.\/lsp" core/ --include="*.ts"`
- [ ] Verify no empty catch blocks: `grep -rn "catch\s*{" core/ tools/ hooks/ lsp/ --include="*.ts"` (empty catch with no body/log)
- [ ] `grep -rn "process\.cwd()" tools/ hooks/ --include="*.ts"` -- should use `getEffectiveRoot()` instead unless there is a documented reason
- [ ] Verify MCP tools match Pi tools: `grep -c "registerTool.*shazam_" mcp/tools.ts` should equal the number of `register*` calls in `index.ts` (currently 9 Pi tools + 2 MCP-only tools)
- [ ] Run `npm audit --omit=dev` -- any known vulnerabilities in runtime dependencies?
