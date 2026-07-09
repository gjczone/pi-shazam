# REVIEW-RULES.md for pi-shazam

You are reviewing **pi-shazam**, a Pi coding agent native codebase awareness toolkit that unifies tree-sitter parsing, LSP protocol communication, and PageRank-based dependency analysis into a set of agent-callable tools. This guide focuses your review on real bugs and reliability issues only.

## Project Context

- **What it is**: TypeScript/Node.js Pi extension providing 7 structural analysis tools (overview, lookup, impact, verify, changes, format, rename_symbol) plus 9 hook modules and 3 inline event handlers, and a standalone MCP server exposing the same 7 tools via stdio JSON-RPC.
- **Size**: 46 TypeScript source files across 5 directories (core/, tools/, hooks/, lsp/, mcp/) + 63 vitest test files. Approaching the "Mature" stage.
- **Runtime**: Node.js >= 18, ESM modules, runs as a Pi extension loaded into the Pi coding agent process.
- **Dependencies**: tree-sitter (multi-language parsing), vscode-jsonrpc + vscode-languageserver-protocol (LSP JSON-RPC), iconv-lite (UTF-8/GBK encoding fallback), @modelcontextprotocol/sdk (MCP server), typebox (tool parameter schemas), zod (MCP validation).
- **Key architecture facts**:
  - Strict 4-layer dependency: `hooks/` → `tools/` → `core/` + `lsp/`. `core/` has zero Pi or LSP imports. Layer violations are not caught by tsc; manual verification required. `mcp/` is a standalone entry point that may import from `tools/`, `core/`, and `lsp/` but must NOT import from `hooks/` (except for pure stateless utility modules -- if a hooks module must be shared, it belongs in `tools/` or `core/`).
  - Module-level mutable state: `cachedGraph`, `_projectRootOverride`, `_scanning` mutex, `_rpcModule`, `_notifications`. All are reset on `session_shutdown`. Concurrent access is guarded by a re-entrancy mutex (`_scanning` flag), not async locks.
  - Tools register via a factory (`tools/_factory.ts`) that auto-injects `json`/`maxTokens` params, scans the project graph, and wraps output in a standardized envelope. Tools with complex async LSP logic use `customExecute` which bypasses auto-scan.
  - MCP server uses `tools/definitions.ts` as single source of truth (SSOT) for tool names, descriptions, and Zod schemas. MCP handlers wrap tool executors with `withLogging` for audit logging and must apply `validatePathInProject` to every user-supplied file path.

## Review Rules

### DO report these (P0 -- must fix)

1. **Layer boundary violations**: A `core/` file importing from `tools/`, `hooks/`, or `lsp/`; a `lsp/` file importing from `tools/` or `hooks/`; a `tools/` file importing from `hooks/`.
2. **Type safety holes**: `as` casts that suppress type errors, `any` usage that bypasses the graph data model, missing null checks on `Map.get()` results where the key may not exist.
3. **Stale graph state bugs**: Code paths that mutate `RepoGraph` maps without updating all related indexes (`nameIndex`, `targetToSources`, `incoming`, `outgoing`). Also: code that reads `cachedGraph` after a scan failure without checking for null. File-level reference maps (`fileCalls`, `fileRefs`, `fileTypeRefs`, `fileImports`, `fileImportBindings`) must be cleared in `removeEdgesForFile` / `removeFileData` alongside edge indexes to prevent phantom edges after incremental scan.
4. **Re-entrancy / concurrency hazards**: Calls to `scanProject()` inside a tool execute path that could be re-entered (the `_scanning` mutex throws on re-entry, but the throw may be swallowed). Async operations on `cachedGraph` without the mutex held.
5. **Resource leaks**: LSP child processes not shut down on `session_shutdown`, timer handles not cleared (e.g., `setTimeout` in `withTimeout`), event listeners not removed on `AbortSignal`. **Includes (see #626 lessons):**
   - Module-level `Map`/`Set`/`Array` that grows over process lifetime without a clear release path. Any new module-level state must be cleared on `session_shutdown` AND exposed as a `reset*()` function for tests.
   - Native C++ handles (tree-sitter `Parser`/`Language`/`Query`, `LspClient` connections) that are recreated unnecessarily. `resetCache()` in `core/scanner.ts` must NOT null out the `TreeSitterAdapter` singleton — native objects cannot be promptly reclaimed by V8 GC and a transient 100-300MB native-heap inflation occurs per reset.
   - Caches that hold large data (RepoGraph, scanner per-file cache, LSP `textDocument/didOpen` state) without a TTL or eviction policy in long-lived MCP mode. Verify on idle.
   - `didOpen` without matching `didClose` — LSP server-side AST accumulates per opened file.
6. **Path traversal / security**: Input file paths not validated against project root (use `validatePathInProject` from `_factory.ts`). Symlink escapes not caught by `realpathSync` check. Commands injected via tool parameters that reach `execSync` or `spawn`.
7. **Data corruption on graph serialization**: `deserializeGraphV2` missing null-guards on cache fields (validated in `data-integrity.test.ts`). Edge deduplication not applied during deserialization. NameIndex not rebuilt after deserialization.
8. **Empty catch blocks**: Any `catch` that silently swallows an error without logging via `_logWarn` or propagating. Especially in LSP request methods, scanner file reads, and hook event handlers.
9. **Encoding boundary bugs**: UTF-8 detection failing when a multi-byte character straddles the 64KB validation chunk boundary (tested in `encoding-boundary.test.ts`). GBK/GB2312 fallback returning garbled text for valid UTF-8 files.
10. **MAX_FILES truncation without warning**: `collectSourceFiles` sets `truncated=true` but if the caller ignores it, the graph is silently incomplete (fixed in #471-A, regression check).
11. **MCP path traversal in file parameters**: Every MCP tool handler that accepts a `file`/`files`/`name` (when detected as a file path) parameter MUST call `validatePathInProject(param, projectRoot)` before accessing the filesystem. Missing validation allows reading/writing files outside PROJECT_ROOT (e.g., `../../etc/passwd`). Also applies to `shazam_format --file` which performs writes.
12. **MCP isMainModule detection failure**: The symlink-resolved `isMainModule` check in `mcp/entry.ts` must correctly identify when the module is the entry point. If it returns false when launched via `npx pi-shazam-mcp`, the server never starts (regression guard for #485).
13. **Text/JSON output data drift**: A tool's `executeXxx` (text) and `executeXxxJson` (JSON) must return the same sections of data, just in different formats. JSON-only consumers (LLM agents) silently lose any section that exists only in text. Add a parity test that round-trips JSON → markdown → original and asserts all sections are present. (Origin: #631.)
14. **MCP `getGraph` stale-cache in long-lived mode**: For MCP processes, any cached `RepoGraph` held in module-level memory must be released on idle (TTL or LRU). A graph holding 500MB-1GB for a long-lived process is a memory leak, not a cache. (Origin: #626.)

### DO report these (P1 -- reliability risk)

1. **Missing error handling in LSP request methods**: `definition`, `references`, `hover`, etc. return `LspResult` but callers may not check `status === "error"` before accessing `.data`.
2. **Silent failures**: `parseFile` in scanner catches errors and returns null -- if the error is not `FileTooLargeError`, the file is silently skipped. Missing symbols may cascade into incorrect impact analysis.
3. **Inconsistent project root**: `process.cwd()` vs `getEffectiveRoot()` vs `_projectRootOverride`. Code that uses `process.cwd()` directly instead of `getEffectiveRoot()` will break when Pi is launched from a parent directory.
4. **Tool description drift**: Pi tool descriptions in `tools/*.ts` not matching MCP tool descriptions in `mcp/tools.ts`. Also: tool descriptions that suggest parameters or behavior the tool does not support.
5. **Notification cap eviction correctness**: `_notifications` Map in `LspClient` is capped at 2000 entries with oldest-first eviction. Eviction preserves insertion order but may drop diagnostics for files that were opened early and never re-saved during a long session.
6. **Token budget truncation**: `truncateOutput` uses 4 chars/token heuristic. If a tool's output contains dense CJK text or very long lines, the heuristic may underestimate and exceed the Pi runtime's actual token budget.
7. **Edge cases in incremental scan**: `scanIncremental` builds `dependentFiles` from `findDependentFiles` but also adds cross-file call edges via `oldIncomingBySymId` snapshot. If the snapshot is stale (graph mutated between snapshot and rebuild), dependent files may be missed.
8. **Pi-MCP schema drift**: `typeboxParams` in `tools/definitions.ts` must include all parameters that exist in `zodParams` (except MCP-specific `maxTokens`/`json` which are auto-injected by the Pi factory). If a parameter exists in zodParams but not typeboxParams, it becomes inaccessible in Pi mode. Conversely, required Pi parameters that are missing from zodParams will cause MCP calls to fail validation.
9. **MCP unsafe type casts**: MCP handlers receive `Record<string, unknown>` from the MCP SDK and cast directly (`as string`, `as boolean`, `as number`, `as string[]`). Zod schemas should validate these at the SDK boundary, but verify the cast types match zod schema types exactly -- a `z.number()` cast as `string` will cause runtime failures.
10. **MCP error response inconsistency**: Some MCP handlers return `{ content: [...], isError: true }` for parameter validation errors, while others `throw` which the SDK converts to a JSON-RPC error. Verify error handling is consistent and user-facing error messages do not leak stack traces or absolute paths.
11. **MCP LSP lifecycle on init failure**: When `lspManager.initializeAll()` throws in `mcp/entry.ts`, the server continues without LSP (graceful degradation). Verify that `setLspManager` receives either a working manager or null, and tools do not crash when LSP is unavailable (tree-sitter-only fallback).
12. **MCP concurrent getGraph calls**: `getGraph()` calls `scanProject()` on every MCP tool invocation without a mutex. Concurrent MCP requests may trigger overlapping scans. `scanProject` has its own `_scanning` guard which throws on re-entry -- verify the throw is caught by `withLogging` and does not crash the MCP transport.
13. **MCP layer violation**: `mcp/tools.ts` must not import from `hooks/`. Currently imports `hasCallChainChecked`/`recordCallChain` from `tools/rename-state.ts` (relocated from `hooks/` — resolved in v0.22.0). Report any new hooks imports added to `mcp/`.
14. **Test pollution in main graph**: `tests/` files should be excluded from the default scan (see #632). Verify that new code in `core/scanner.ts` `collectSourceFiles` and `core/filter.ts` respects the `isTestFile` predicate and the `PI_SHAZAM_INCLUDE_TESTS` opt-in. Test mocks must not appear in `shazam_lookup` or `shazam_overview` results unless explicitly enabled.
15. **Affected Tests only on one impact mode**: `shazam_impact` must report affected tests in BOTH `--files` and `--symbol` modes (see #635). Before that fix, the inconsistency was a real LLM agent blind spot.
16. **Output placeholder strings**: Tool output templates must not contain placeholder text like `PICK FROM`, `[REVIEW]`, `TODO`, `<insert-here>`, `XXX`. These slip past code review and reach LLM agents verbatim.
17. **Summary counter math must add up**: `shazam_verify`'s "Errors | Warnings | Total" line (and similar counters in any tool) must be self-consistent. If `Total` includes more severities than the named buckets, show the breakdown (e.g., `Errors: 2 | Warnings: 1 | Info: 3 | Hint: 1`) or drop `Total` entirely.
18. **Error class conflation**: When a tool's path validation rejects user input, the error must distinguish (a) path traversal (security) from (b) file not found (typo). Conflating them wastes an LLM turn. See #636.

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

| File                   | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/scanner.ts`      | `scanProject` / `scanIncremental` / `scanFull`: stale index bugs in `removeFileData` and `removeEdgesForFile` (4 index maps + 5 file-level maps must stay consistent: `fileCalls`, `fileRefs`, `fileTypeRefs`, `fileImports`, `fileImportBindings`). `findDependentFiles` reverse index correctness. `_projectRootOverride` not propagated to all scan paths. `_scanning` mutex not reset on exception (the `finally` block should handle it -- verify). Edge kinds: import (0.3/0.5), call (1.0/0.9), ref (0.5/0.9), type (0.4/0.8), import-binding (0.8/1.0). |
| `core/graph.ts`        | `deserializeGraphV2`: null-guard on every cache field; dangling edge skip with `_logWarn`. `compareGraphSnapshots`: edge identity includes weight/confidence; stable-key reconciliation correctness. `nameIndex` rebuild after deserialization must match `scanFull` behavior.                                                                                                                                                                                                                                                                                  |
| `lsp/client.ts`        | `withTimeout`: timer cleanup in all paths (resolve, reject, cancel). `_sendRequest`: `CancellationTokenSource` disposed in finally; external token listener removed. `_notifications` cap eviction: oldest-first is correct but verify it does not evict the most recently updated entry. `_cleanupAfterCrash` idempotency (the `_cleanedUp` latch).                                                                                                                                                                                                            |
| `tools/_factory.ts`    | `validatePathInProject`: `realpathSync` is called but the resolved real path is not returned -- callers must re-resolve. `createTool`: error path in `execute` callback -- when `domainFn` throws and `json=false`, the error is returned as `isError: true` but not logged via `_logWarn`.                                                                                                                                                                                                                                                                     |
| `tools/definitions.ts` | SSOT for tool names, descriptions, typeboxParams (Pi), and zodParams (MCP). Every parameter in zodParams must have a corresponding typeboxParams entry (except `maxTokens`/`json` auto-injected by Pi factory). Required params in one schema must be required in the other. Tool names must use `shazam_` prefix consistently.                                                                                                                                                                                                                                 |
| `mcp/entry.ts`         | `validateProjectRoot`: home-only check is opt-in via `PI_SHAZAM_HOME_ONLY`; default must accept any valid directory (#465). `isMainModule`: symlink resolution must work for both `dist/mcp/entry.js` (compiled) and source-level vitest runs (#485). Version detection: package.json search must check both `../..` and `..` paths. LSP init failure must not prevent server startup (graceful degradation). Shutdown: `_shuttingDown` latch must prevent double-LSP-shutdown across SIGINT/SIGTERM/transport.onclose/stdin('end').                            |

### Tier 2 -- State & Recovery

| File              | What to check                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/cache.ts`   | `saveGraphCache`: serialization must be atomic (no partial writes). `loadGraphCache`: corrupted JSON must not crash -- the try/catch around `JSON.parse` should catch all parse errors. Version mismatch handling (currently only v2 supported).                                                            |
| `lsp/manager.ts`  | `initializeAll`: timeout guard via `Promise.race` -- verify cleanup on timeout (orphaned processes). `shutdown`: all clients shut down in parallel; verify no unhandled rejection if one client fails. `detectLanguages`: file walk uses `readdirSync` -- verify skip-dir logic for `node_modules`, `.git`. |
| `hooks/safety.ts` | Destructive command patterns: regex coverage for bypass variants (extra spaces, tabs, split flags). `tokenizeSegments`: chained command parsing (e.g., `echo safe && git commit`). Pre-commit gate: `hasRecentPassingVerify` timer -- verify the 5-minute window is not too short/long.                     |
| `core/output.ts`  | `_logWarn`: ENOENT suppression is correct but verify other expected error codes (EACCES, EPERM) are NOT suppressed. `truncateOutput`: high-priority line detection by prefix -- verify important detail lines starting with `- ` are not dropped.                                                           |

### Tier 3 -- Tools & Entry Points

| File              | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | Registration order: `before_agent_start` handler must be registered before `registerBeforeStartHook`. LSP init timeout handler: verify `lspManager.shutdown()` is called on timeout but does not throw into the catch path. `session_shutdown`: cache reset order -- scanner cache then LSP enrich state; verify both are guarded by try/catch.                                                                                                                                                                                                                                                                           |
| `tools/impact.ts` | Call chain traversal: edge weight and confidence thresholds. Cycle detection -- verify infinite loops in circular dependencies are prevented. Output truncation -- verify the token budget is respected.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools/verify.ts` | Orphan detection: symbols with zero incoming edges. Verification categories (type errors, new orphans, lint) -- verify each category is independently computed and failures in one category do not suppress others.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mcp/tools.ts`    | Pi-MCP sync: every tool registered via `getToolDefinition(name)` must match the tool names in `TOOL_DEFINITIONS`. All `file`/`files`/path params must call `validatePathInProject` before filesystem access. `withLogging` must wrap every handler. Type casts (`as string`, `as boolean`, etc.) must match zod schema types. `withLogLock` promise chain must not deadlock. `isError: true` must be set on error responses to trigger MCP client error display. Rename safety gate (`hasCallChainChecked`) must be enforced for non-dry-run renames. Audit log writes must be fire-and-forget (never block the handler). |

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
- [ ] `grep -r "TODO\|FIXME\|HACK\|XXX" core/ tools/ hooks/ lsp/ mcp/ --include="*.ts"` -- any leftover markers?
- [ ] `grep -r "console\.\(log\|error\)" core/ tools/ hooks/ lsp/ mcp/ --include="*.ts"` -- are there debug logs that should use `_logWarn`? (Exclude `_logWarn`'s own `console.warn` and entry.ts `console.error` for startup errors)
- [ ] `grep -rn "as " core/ lsp/ mcp/ --include="*.ts" | grep -v "as const\|as string\|as number\|as never\|as unknown\|as boolean"` -- any unsafe type casts?
- [ ] Verify no `core/` file imports from `tools/`, `hooks/`, or `lsp/`: `grep -rn "from '\.\.\/tools\|from '\.\.\/hooks\|from '\.\.\/lsp" core/ --include="*.ts"`
- [ ] Verify no `mcp/` file imports from `hooks/`: `grep -rn "from.*hooks" mcp/ --include="*.ts"` (currently only `rename-state.ts` -- a known issue to relocate)
- [ ] Verify no empty catch blocks: `grep -rn "catch\s*{" core/ tools/ hooks/ lsp/ mcp/ --include="*.ts"` (empty catch with no body/log)
- [ ] `grep -rn "process\.cwd()" tools/ hooks/ mcp/ --include="*.ts"` -- should use `getEffectiveRoot()` (Pi) or `projectRoot` parameter (MCP) instead
- [ ] Verify MCP tools count matches Pi tools: `grep -c "server\.registerTool" mcp/tools.ts` equals 7 (one per tool in TOOL_DEFINITIONS)
- [ ] Verify all MCP file params use validatePathInProject: `grep -c "validatePathInProject" mcp/tools.ts` must be >= 4 (lookup name-as-path + lookup file param + impact files loop + format file), and verify no new file-accepting tool was added without calling it
- [ ] Verify typebox/zod param parity: for each tool in `tools/definitions.ts`, every required param in typeboxParams must exist in zodParams and vice versa (except `maxTokens`/`json` which are auto-injected by Pi factory and MCP-only)
- [ ] Run `npm audit --omit=dev` -- any known vulnerabilities in runtime dependencies?
- [ ] **Memory check**: For any new module-level `Map`/`Set`/`Array` or new cache, verify it has (a) a `reset*()` function exported for tests, and (b) a clear release path on `session_shutdown`. Native handles (tree-sitter Parser, LSP client) must not be recreated in hot paths.
- [ ] **Output parity check**: For each tool, `executeXxx` and `executeXxxJson` must expose the same data sections. Grep for `lines.push(` and JSON keys side-by-side; add a parity test.
- [ ] **MCP idle memory**: For any new `cachedGraph`-style long-lived state, verify there's a TTL or LRU release path (`PI_SHAZAM_GRAPH_TTL_MS` pattern, see #626).
- [ ] **LSP didOpen/didClose balance**: For each `didOpen` call site, verify there's a matching `didClose` path (verify, lookup, etc.). Unbalanced `didOpen` accumulates LSP-server-side AST.
- [ ] **Test exclusion**: Verify `tests/` files are excluded by default from the main graph (see #632). Test mocks must not pollute `shazam_lookup` / `shazam_overview`.
- [ ] **Output placeholder strings**: Grep tool output templates for `PICK FROM`, `[REVIEW]`, `TODO`, `<insert-here>`, `XXX`. Placeholder text slipped through to LLM agents is a real bug.
- [ ] **Summary counter math**: For any tool that reports a counter summary (errors/warnings/total etc.), the math must be self-consistent or the breakdown must be explicit.

## Windows-Specific Review Rules

pi-shazam runs on Windows (cmd, PowerShell 5/7, Git Bash) as a standalone MCP server. The local MCP path is the most failure-prone surface on Windows. Review these in addition to the P0/P1 lists above.

### P0 -- must fix (Windows correctness / process safety)

- **W1. Path normalization at ingress**: Every user- or tool-supplied path on Windows must pass through `normalizePathInput()` before `realpathSync`/`resolve`. Git-Bash `/c/foo` and WSL `/mnt/c/foo` styles must be normalized to `C:\foo`, and mixed `\`/`/` must be collapsed. A new function that accepts a path and calls `resolve()`/`realpathSync()` directly without normalization will corrupt the graph cache key and break LSP (symlink vs resolved path mismatch). See #673.
- **W2. Symlink privilege guard**: Creating a symlink on Windows requires admin or Developer Mode. Any `symlinkSync` call (tests OR production) MUST be wrapped in try/catch with a graceful fallback, or preceded by a privilege probe. A bare `symlinkSync` throws `EPERM` on a normal Windows machine and crashes the process/test. See #485, #678.
- **W3. MCP process lifecycle / no zombie**: `mcp/entry.ts` must guarantee LSP child processes are `shutdown()`-ed before the process exits, and `process.exit` must be deferred via `setImmediate` (#599) so pending I/O flushes. New `process.exit` calls must NOT terminate immediately (orphaned LSP children). The server must NOT spawn multiple MCP processes -- `isMainModule` is the single entry gate (#485).
- **W4. LSP discovery on Windows**: `lsp/manager.ts` `findInPath` bypasses the POSIX-only `SAFE_PATH_DIRS` filter on `win32` and `isExecutable` is PATHEXT-aware. When adding a new LSP server spec, you MUST provide a `win32` install/discovery path; otherwise the server silently degrades to tree-sitter-only on Windows with no error.

### P1 -- reliability risk (Windows)

- **W5. Encoding fallback**: `core/encoding.ts` adaptive reader (UTF-8 -> GBK -> GB2312) is mandatory. Any `readFileSync` of source must use `_readFileAdaptive`; a direct `readFileSync` will emit garbled text for valid GBK files and corrupt symbol extraction.
- **W6. Platform-aware timeouts**: Any new heavyweight synchronous or child-process operation (scanProject, LSP init) MUST account for win32 timeout scaling (1.5x, #677). Hardcoded 30s/60s values can be too short under Windows load. `vitest.config.ts` win32 `testTimeout` is already 180s -- keep new long tests mindful of that.
- **W7. Explicit `process.platform` branches**: New platform-specific logic MUST use `process.platform === "win32"` explicitly; do not assume POSIX separators or paths. Use `path.sep` / `path.resolve` for cross-platform comparisons (#668).
- **W8. No absolute Windows paths in user output**: Error/audit messages must not leak absolute local paths (`C:\Users\...`) to the LLM or logs. Use paths relative to PROJECT_ROOT.

## AI-Prone Mistakes -- patterns to reject

These are the failure modes LLM-generated patches most often introduce. Reject any diff that exhibits them unless there is a concrete, explained reason.

- **A1. Swallowed errors / empty catch**: Any `catch {}` or `catch (e) { /* ignore */ }` with no `_logWarn` and no rethrow. AI patches frequently "make it compile" by emptying a catch. Every `catch` MUST log (what operation failed, the input context, the original `err.message`) or propagate. Empty catch blocks are forbidden project-wide (AGENTS.md Hard Boundaries).
- **A2. `any` bypassing the data model**: `as any`, `: any` parameters/returns, or `any` in shared types hide RepoGraph/Symbol/Edge shape mismatches. Use concrete types; if a boundary truly needs looseness, use `unknown` + a runtime narrowing guard, never `any`.
- **A3. Unsafe `as` casts on unknown input**: Casting `Record<string, unknown>` (MCP SDK payloads) directly with `as string`/`as X` without Zod validation or a runtime `typeof` check will fail at runtime. Validate at the boundary, then assert.
- **A4. `process.exit` at module load**: A module-top-level `process.exit` kills the host worker under vitest and cascades test failures (#676). All exits belong inside `main()` / behind the `isMainModule` guard, and must be deferred via `setImmediate` where I/O is pending.
- **A5. Masked original error**: `catch (e) { throw new Error("failed"); }` discards `e`. Preserve the cause: `new Error("context", { cause: e })` or append `e.message`.
- **A6. Orphaned child processes**: `spawn`/`execSync` of LSP or git without a teardown path (SIGTERM handler, `shutdown()`, `AbortSignal`) leaks processes that accumulate as zombies. Every spawned process needs a matched cleanup.
- **A7. Test pollution via module-level state / env**: Tests that mutate `process.env`, `setProjectRoot`, or module-level caches MUST restore them in `afterEach`/`afterAll`. E2E tests that `spawn` a child MUST pass a cleaned `env`, never inherit the (possibly mutated) parent env -- a leaked `PI_SHAZAM_HOME_ONLY=1` makes the child reject its root and exit before responding (#676).
- **A8. Floating / unawaited promises**: `async` calls not `await`ed (errors vanish); `throw` inside a `setTimeout` callback (never propagates). Await or attach `.catch`.
- **A9. Over-broad try/catch**: Wrapping an entire function in one `try` hides the real failure site. Catch at the boundary where you can actually handle or log the error.
- **A10. Hardcoded platform paths**: Hardcoding `/home`, `/tmp`, `C:\Users`, or assuming a fixed drive letter. Use `os.tmpdir()`, `process.env.HOME || process.env.USERPROFILE`, and `path.resolve`.

## Windows / AI greps to add to the sanity checklist

Run these alongside the checklist above:

- `grep -rn "process.exit" mcp/ core/ --include="*.ts"` -- every call must be inside `main()` / behind `isMainModule`, and (where I/O is pending) deferred via `setImmediate`. No module-top-level `process.exit`.
- `grep -rn "symlinkSync" --include="*.ts"` -- every call must have a try/catch or a privilege probe.
- `grep -rn "catch\s*{\s*}\|catch\s*(e)\s*{\s*}\|/\*\s*ignore\s*\*/" core/ tools/ hooks/ lsp/ mcp/ --include="*.ts"` -- reject empty catch blocks.
- `grep -rn "as any" core/ tools/ hooks/ lsp/ mcp/ --include="*.ts"` -- reject `any` casts.
- `grep -rn "readFileSync" core/ tools/ --include="*.ts"` -- must use `_readFileAdaptive` (encoding fallback).
- `grep -rn "spawn\|execSync" core/ tools/ lsp/ mcp/ --include="*.ts"` -- verify each spawned process has a matched teardown path.
- `grep -rn "resolve(process.argv\|process.argv\[2\]" mcp/ --include="*.ts"` -- argv-derived root must be normalized and validated, never trusted blindly.
