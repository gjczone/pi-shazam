# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.0] - 2026-06-23

### Security

- **fix(#413-C4): file symlink path traversal (reading outside project root)** — resolved symlink realpath is now validated to be within project root before adding to files array; malicious symlinks like `src/evil.ts -> /etc/shadow` are now skipped with a warning
- **fix(#413-M8): missing path validation in impact and find_tests tools** — added `validatePathInProject` checks for user-supplied file path parameters in `shazam_impact` and `shazam_find_tests` as defense-in-depth
- **fix(#413-M9): MCP path validation uses process.cwd() not configured projectRoot** — MCP `registerAllTools` now accepts `projectRoot` parameter and uses it consistently for all path validations
- **fix(#413-M10): predictable temp file name in rename_symbol atomicWriteFile** — replaced `filePath + ".tmp." + process.pid` with `crypto.randomUUID()` based filename to prevent symlink attacks on multi-user systems

### Bug Fixes

- **fix(#413-C1): file symlinks silently skipped in directory walk** — fixed the `else if` chain fall-through bug; file symlinks are now properly detected and treated as regular files after validating their target is within project root
- **fix(#413-C2): LSP server process leak — concurrent shutdown + init race** — added `_shuttingDown` check inside `_initServerForLanguage` right before `this.servers.set()`; if shutdown was triggered during init, the client is closed immediately instead of leaking the process
- **fix(#413-C3): scanner and LSP use different project roots** — scanner now uses `_projectRootOverride` when caller passes `"."` (default path), ensuring tree-sitter analysis and LSP analysis run on the same directory when Pi detects the project in a subdirectory
- **fix(#413-H1): ref edges lost after disk cache load + incremental scan** — added `fileRefs` to `SerializedGraphV2`; refs are now serialized and restored from disk cache, fixing the silent loss of same-file ref edges after the first incremental scan following a cache load
- **fix(#413-H2): LSP crash recovery re-reads files with UTF-8 only (encoding bypass)** — replaced `readFileAsync(absPath, "utf-8")` with `readFileAdaptiveAsync` for the crash recovery re-open path
- **fix(#413-H3): encoding blindness — 15+ call sites bypass readFileAdaptive** — replaced all project-file reads with `readFileAdaptive` / `readFileAdaptiveAsync` across `tools/overview.ts`, `tools/find_tests.ts`, `tools/format.ts`, `core/formatters.ts`, `core/git-hooks.ts`, and `hooks/shazam-guide.ts`
- **fix(#413-H4): Python __all__ triple-quoted strings not stripped correctly** — updated regex to handle 1-3 quotes (`['"]{1,3}`) on both ends; triple-quoted strings like `'''foo'''` now correctly match real symbols
- **fix(#413-H5): TreeSitter _within() uses strict inequality — boundary symbols missed** — changed strict `>`/`<` to `>=`/`<=` for start/end position comparison; symbols starting at exactly the same row+column as the definition node are now correctly considered "within"
- **fix(#413-H6): deserialized graph may have dangling edges** — `deserializeGraphV2` now skips edges where source or target symbol IDs don't exist in `graph.symbols`, logging a warning for each skipped edge to prevent crashes in downstream code
- **fix(#413-M2): saveGraphCache has no size limit — OOM risk for huge projects** — added 20MB size limit check on save (matching the load-side limit); `JSON.stringify` result is checked before writing, and cache is skipped with a warning if too large
- **fix(#413-M3): _cleanupAfterCrash called twice (error + exit events)** — added `_cleanedUp` flag that `_cleanupAfterCrash` checks and sets on first entry, separate from `_closing` which is for intentional shutdown only
- **fix(#413-M4): import line numbers lost after cache deserialization** — `fileImports` now serialized as `[string, number][]` tuples to preserve line numbers instead of flattening to `string[]`
- **fix(#413-M5): compareGraphSnapshots edge diff ignores weight and confidence changes** — edge identity now includes weight and confidence (`${source}::${target}::${kind}::${weight}::${confidence}`), so modified edges are detected not just added/removed ones
- **fix(#413-M6): error object discarded in multiple catch blocks** — all catch blocks in `tools/lookup.ts` and `tools/verify.ts` now capture and log the actual error object instead of just a fixed-string warning
- **fix(#413-M7): fire-and-forget audit log promise with empty catch** — replaced `_writePromise.catch(() => {})` with proper error logging so unexpected errors from `redact()` or `JSON.stringify()` are surfaced
- **fix(#413-M11): _scanSeenEdges not reset to null on scan exception** — `_scanSeenEdges` is now reset to null in the `finally` block of `scanProject` alongside `exitScan()`, preventing state leakage across scans
- **fix(#413-L1): redundant removeEdgesForFile calls in incremental scan** — removed duplicate `removeEdgesForFile` call for changed files (was called once in changedFiles loop and again in dependentFiles loop)
- **fix(#413-L2): same Parser instance shared between javascript and typescript keys** — TypeScript grammar fallback now creates a separate Parser instance instead of storing the same object under both keys
- **fix(#413-L3): hardcoded magic numbers in _extractStandardSymbols** — extracted `MAX_NAME_NODES` and `MAX_MATCHING_DEFS` named constants (5000 each) from the method body
- **fix(#413-L7): params.project = project mutates caller's params object** — factory now uses spread operator to create a new params object (`effectiveParams`) instead of mutating the caller's object
- **fix(#413-L8): LspClient cmd! non-null assertion on command array** — added explicit validation that the command array has at least one element; logs error and triggers cleanup if empty

### Housekeeping

- **fix(#413-L4): dead symlink cycle detection code removed** — cleaned up dead code that tracked symlink paths instead of real target paths
- **fix(#413-L5): trivial getProjectGraph wrapper removed** — eliminated the no-value wrapper that just called `scanProject()` unconditionally (caching is already inside scanProject)
- **fix(#413-L6): dead ternary — condition always true** — removed redundant ternary inside an already-guarded `if (realStat.isDirectory())` block

## [0.17.0] - 2026-06-23

### Security

- **fix(#394): safety.ts git commit early-return bypasses ALL destructive command checks** — removed the `isGitCommit` early return in `detectDestructiveCommand` that allowed commands like `git commit -m x && rm -rf /` to bypass all safety checks; the `--no-verify` handling is already covered by the pre-commit gate (Check 2)
- **fix(#395): MCP shazam_lookup path traversal** — added `validatePathInProject` checks in the MCP handler and as defense-in-depth in `_executeFileDetailAsync` and `executeLookupAsync`, closing the path-traversal hole where MCP clients could read arbitrary files outside the project root
- **fix(#402-P2-3): MCP rename bypasses safety gate + dryRun defaults to destructive** — MCP `shazam_rename_symbol` now defaults `dryRun` to `true` (matching Pi path) and enforces the `hasCallChainChecked` impact-check safety gate
- **fix(#402-P2-4): MCP entry allows PROJECT_ROOT "/"** — removed `realRoot === "/"` allowance; replaced `startsWith(homeDir)` with path separator boundary check to prevent prefix confusion

### Bug Fixes

- **fix(#393): indefinite repeated verification reminder** — added `_reminderSent` flag to `verify-state.ts`; reminder is sent once per edit cycle and resets on new edit, verify call, or session reset
- **fix(#396): lsp_enrich CTS cancellation disconnected from client request** — added `externalToken` parameter to all 12 public LSP client methods; linked external token to internal CTS in `_sendRequest` so enrich-layer cancellation now propagates to the actual LSP request
- **fix(#397): setLspManager swaps manager before previous shutdown completes** — made `setLspManager` async, awaiting previous manager shutdown before swapping; MCP entry point now properly awaits
- **fix(#402-P2-1): runFormatterCommand swallows execFileSync failure** — `runFormatterCommand` now rethrows on formatter failure so `runFormatters` pushes `[FAIL]` instead of `[OK]`
- **fix(#402-P2-2): hand-built file:// URI instead of pathToUri** — replaced `file://${filePath}` with `pathToUri(filePath)` in type-hierarchy request for correct URI encoding

### Performance

- **fix(#398): scanner.ts O(N*M) imports.includes on incremental scan hot path** — built `fileImportedBy: Map<string, Set<string>>` reverse import index for O(1) dependent lookup; incremental scan no longer scans every file's import list
- **fix(#399): lookup.ts constructs new TreeSitterAdapter per _extractDocstring call** — replaced per-call `new TreeSitterAdapter()` with module-scoped lazy singleton; hover batch of 20 symbols no longer triggers 20 full grammar loads
- **fix(#402-P3-1): sequential await of independent supertypes/subtypes** — changed to `Promise.all` for parallel type hierarchy requests
- **fix(#402-P3-2): sequential await + readFileSync in crash re-open loop** — changed to async file reads with `Promise.allSettled` for didOpen calls
- **fix(#402-P3-3): Array.includes on BFS hot path** — converted `files` to `Set<string>` for O(1) lookup in impact analysis
- **fix(#402-P3-5): sync readFileSync in format scan loops** — changed `detectIndentationStyle` and `scanFormatIssues` to async concurrent file reads

### Refactoring

- **fix(#400): pi-extension.d.ts stub gaps force as-unknown-as casts** — added `input?: unknown` and `toolCallId?: string` to `ToolCallEventBase`; removed 9 `as unknown as` double-casts across hooks and tools; added `isLocationLinkArray` type guard in `lsp_enrich.ts`
- **fix(#401): decorative Unicode in 48 source files** — replaced 272 occurrences of em-dash (U+2014) and arrow (U+2192) with ASCII equivalents (`--`/`-` and `->`) across all non-test source files and tool output

### Housekeeping

- **fix(#402-P3-4): silent 100-file cap without truncation flag** — `scanFormatIssues` now emits `... and N more files not scanned` when `files.length > 100`

## [0.16.0] - 2026-06-23

### Security

- **fix(#380): shazam_lookup path traversal guard** — user-supplied `name`/`file` params now validated with `validatePathInProject` before reaching `statSync` or LSP `didOpen`/`readFileAdaptiveAsync`; `LspManager.getServerForFile` adds projectRoot prefix check as defense-in-depth

- **fix(#383): safety hook RCE blocklist expansion** — 7 new HIGH_RISK_PATTERNS: `eval`, `source`/`.`, `curl|sh`, `wget|bash`, `base64|sh`, backtick substitution, process substitution `<(...)`; prevents prompt-injected arbitrary code execution bypassing the confirmation dialog

### Bug Fixes

- **fix(#381): LSP CTS cancellation not wired (#376 regression)** — `withEnrichTimeout` now accepts optional `CancellationTokenSource`; on timeout, `cts.cancel()` fires so the underlying LSP request frees server resources. All 7 callers create and dispose a CTS.
- **fix(#381): ensureFileOpened crash-recovery gap** — `ensureFileOpened` now calls `ctx.trackOpenedFile(language, filePath)` after didOpen, so files opened via lookup/hover/rename survive LSP crash recovery
- **fix(#381): initialize connection! race** — `initialize()` caches `this.connection` into a local `conn` variable before the `await`, eliminating the non-null assertion race with `_cleanupAfterCrash`
- **fix(#382): collectDiagnostics O(N^2) performance** — `_notifications` changed from array to `Map<string, PublishDiagnosticsParams>`; notification arrival uses `.set()` (O(1) upsert); `collectDiagnostics` iterates Map entries instead of reverse-loop with unshift
- **fix(#384): rename_symbol non-atomic write** — `writeFileSync` replaced with `atomicWriteFile` (tmp+rename) for both write and rollback paths, preventing source corruption on SIGKILL/OOM
- **fix(#384): rename_symbol hardcoded scanProject root** — `scanProject(".")` now uses `params.project || process.cwd()`; `validatePathInProject` passes consistent projectRoot
- **fix(#385): Tree interface missing delete()** — `Tree` interface adds `delete?(): void`, removing `as any` cast in `lookup.ts` and `as unknown as` cast in `scanner.ts`

### Housekeeping

- **fix(#386): Chinese comments translated to English** — 16 source files translated to comply with LANGUAGE RULE (English-only hard requirement); `types/pi-extension.d.ts` preserved as upstream stubs
- **fix(#387): silent catch blocks eliminated** — 28 catch blocks across 14 files now log with `console.warn` before returning fallback; 3 `.catch(() => {})` replaced with logged catch; decorative `└` (U+2514) in tool output replaced with ASCII `-`
- **fix(#388): P3 cleanup** — decorative Unicode `─`/`→` in comments replaced with ASCII `-`/`->`; go.mod filter over-exclusion fixed; dead `validatePathInProject` check removed; `Array.includes` -> `Set.has` for O(1) dedup in impact.ts; `setTimeout` in manager shutdown now cleared; `!!!`/`!` replaced with `[HIGH]`/`[MED]` in safety.ts; 4 new secret patterns added to redact.ts (GitLab PAT, Google API key, SendGrid API key, Twilio API key)

## [0.15.3] - 2026-06-22

### Bug Fixes

- **fix(#376): security hardening, LSP resource management, and error handling** (#377)
  - **Security**: PATH scanning restricted to trusted system directories (`SAFE_PATH_DIRS`) — prevents command injection via manipulated `PATH` environment variable; PROJECT_ROOT validated to be within user home directory with symlink escape detection; `_factory.ts` `validatePathInProject` hardened with realpath traversal check
  - **LSP lifecycle**: `_doClose` race condition fixed (check exitCode before removing listeners); `_docVersions` cleared on cleanup to prevent stale state accumulation; old LSP client properly closed before language re-initialization; `proc.kill()` guarded against already-exited processes; `withTimeout` CTS cancel guard added
  - **Error handling**: 25+ empty catch blocks replaced with `console.warn` diagnostics across `core/`, `lsp/`, `hooks/`, `mcp/`, `tools/` — every error branch now either handles (with a log) or propagates
  - **Safety hook**: `--no-verify` detection fixed to handle combined short flags like `-nq`, `-qn` (previously only matched standalone `-n`)
  - **LSP diagnostics polling**: replaced fixed 500ms wait with adaptive polling (5 attempts × 200ms, stops early when diagnostics arrive) — prevents stale/empty diagnostic results on slower LSP servers
  - **LSP enrichment**: simplified `withEnrichTimeout` — removed duplicate CTS cancel logic (already handled by `_sendRequest`)

- **fix(#378): CTS timing and SAFE_PATH_DIRS expansion** (#379)
  - `_sendRequest` CTS dispose timing fixed: CTS was disposed synchronously before the returned Promise settled, causing premature CancellationToken cleanup; now uses proper async disposal pattern
  - `SAFE_PATH_DIRS` expanded to include `/opt/homebrew/bin` and `/snap/bin` — Homebrew (macOS) and snap (Linux) users can now auto-detect LSP servers installed via these package managers

### Housekeeping

- **chore(#378): Prettier formatting** — `core/git-hooks.ts`, `tools/verify.ts`, `hooks/safety.ts` had code style drift; reformatted to match project Prettier config

### Documentation

- **docs(#378): agent checklist expansion** — added user rule anchors (address as 老板, completion report format, code comment conventions, no empty catch blocks) to AGENTS.md checklist
- **docs(#378): Kimi Code hooks sync** — updated `docs/kimi-code-hooks.md` version mapping for v0.15.3 tool name consolidation sync across all Kimi Code shell hooks

## [0.15.2] - 2026-06-22

### Bug Fixes

- **fix(#362): Dart LSP server never activated** — `_detectLanguage()` was missing `.dart` mapping, causing the Dart language server (configured in `lsp/servers.ts`) to never be used for `.dart` files. Dart/Flutter projects now get full LSP diagnostics, hover, and type hierarchy support.

### Documentation

- **docs(#362): full documentation audit** — synced language counts (6→7 for tree-sitter+LSP across README, SKILL, mcp/README, INSTRUCTION), added missing files to architecture trees (`changes.ts`, `definitions.ts`, `git-utils.ts`), updated hook mapping tables (`issue-guard.ts`, `agent-context-guard.ts`), fixed OPS.md checklist references, added `types/*.d.ts` to prettier paths, corrected tool count in package.json (14→9)
- **docs(#362): AGENTS.md version sync** — updated version reference from v0.14.2 to current

## [0.15.1] - 2026-06-22

### Bug Fixes

- **fix(#362): JSON envelope command names after tool consolidation** — `shazam_impact` flat mode JSON now uses correct envelope (`shazam_impact` instead of bare JSON); `shazam_overview` hotspots JSON envelope uses `shazam_overview` instead of old `shazam_hotspots`
- **fix(#362): mutually exclusive `--files`/`--symbol` in impact** — passing both now returns a clear error instead of silently dropping `--files`
- **fix(#362): empty files array in impact** — `--files []` now returns an error instead of showing misleading empty results
- **fix(#362): MCP impact depth unclamped** — MCP handler for `shazam_impact` now clamps depth to [1,10] matching Pi tool behavior
- **fix(#362): MCP lookup no file path detection** — `shazam_lookup` MCP handler now detects file paths and dispatches to file detail
- **fix(#362): MCP impact missing error for no params** — returns clear error when neither `--symbol` nor `--files` is passed
- **fix(#362): MCP changes missing JSON support** — `shazam_changes` MCP handler now supports `{ json: true }`
- **fix(#362): GBK encoding crash in hover/type hierarchy** — `_getHoverInfo` and `_getTypeHierarchy` now use `readFileAdaptive` (UTF-8 → GBK → GB2312 fallback) instead of hardcoded `readFileSync("utf-8")`
- **fix(#362): duplicate deps section titles** — Python/Rust/Go dependency sections now use language-specific titles (`### Key Python/Rust/Go Dependencies`)
- **fix(#362): verify text mode missing verdict** — `shazam_verify` text output now shows `### Verdict: PASS/WARN/FAIL` (including lspOnly mode)
- **fix(#362): PageRank decimal inconsistency** — all PageRank values now use `.toFixed(4)` across overview, lookup, and hotspots output
- **fix(#362): `executeCallChainJson` missing rename state record** — now calls `recordCallChain()` matching `executeCallChain` behavior
- **fix(#362): MCP entry hardcoded version** — version now reads from `package.json` at startup, preventing stale version display
- **fix(#362): MCP entry double shutdown** — added reentrancy guard to prevent `transport.onclose` and `stdin.end` from triggering overlapping LSP shutdown

### Performance

- **perf(#362): parallel hover lookups** — `shazam_lookup` now fetches hover info for all symbol matches concurrently via `Promise.all` instead of serial `for...of` + `await`
- **perf(#362): reuse fileStats in overview** — `_computeHotspots` now accepts precomputed `fileStats` from `_buildOverviewText`, avoiding duplicate graph traversal

### Robustness

- **robust(#362): split TypeHierarchy error handling** — LSP `prepareTypeHierarchy`, `typeHierarchy/supertypes`, and `typeHierarchy/subtypes` now have independent try/catch blocks so partial results are preserved when one request fails
- **robust(#362): use lsp_enrich layer for hover** — `_getHoverInfo` now uses `ensureFileOpened` from shared LSP infrastructure instead of manual `didOpen`, benefiting from mtime tracking and proper timeout handling

### Documentation

- **docs(#362): expanded file path detection** — `_isFilePath` regex now recognizes `.yaml`, `.yml`, `.css`, `.scss`, `.less`, `.sh`, `.bash`, `.toml`, `.html`, `.htm`, `.md`
- **docs(#362): improved error messages** — filter empty result suggests removing `--filter`; symbol not found suggests `shazam_overview`; compact mode output now includes count header

### Housekeeping

- **chore(#362): remove dead code** — `_extractContextLines` (unused return value), `contextLines` field from `HoverInfo`, and stale `describe.skip` test blocks referencing deleted module files

## [0.15.0] - 2026-06-22

### Refactoring

- **refactor(#362): Tool consolidation 14->9 -- unified lookup, impact+call_chain, overview+hotspots**
  - Merged `shazam_symbol`, `shazam_file_detail`, `shazam_hover`, `shazam_type_hierarchy` into `shazam_lookup` (auto-detects file path vs symbol name)
  - Merged `shazam_call_chain` into `shazam_impact` (new `--symbol` parameter for per-symbol tracing)
  - Merged `shazam_hotspots` into `shazam_overview` (hotspots section shown at end of overview)
  - Renamed `shazam_fix` to `shazam_format` (precise naming, avoids LLM confusion)
  - Added `shazam_changes` -- lightweight git change summary with risk level
  - Deleted `shazam_codesearch` (overlaps with ffgrep)
  - Updated all hooks, MCP tools, NEXT_RULES, and definitions to match new tool names

### Breaking Changes

- Tool count reduced from 14 to 9. LLM agents using old tool names (`shazam_symbol`, `shazam_file_detail`, `shazam_hover`, `shazam_type_hierarchy`, `shazam_call_chain`, `shazam_hotspots`, `shazam_codesearch`, `shazam_fix`) must update to new names.
- `shazam_impact --files` parameter is now optional when using `--symbol` mode.

## [0.14.2] - 2026-06-22

### Bug Fixes

- **fix(#355): systemPrompt character explosion** — `event.systemPrompt` is `string` at runtime but code treated it as `string[]`, causing `[...spread]` to explode each character onto its own line and inflate the system prompt from 3K to 102K tokens. Now uses `Array.isArray()` to handle both types safely. External report by @finnvyrn.
- **fix(#354): defensive graph.symbols check** — `rename_symbol` now validates `graph?.symbols` before use to prevent "Cannot read properties of undefined" crashes in edge cases.

### Features & Enhancements

- **enhance(#353): error-type-specific failure recovery** — `hooks/failure-recovery.ts` now parses error messages to provide targeted suggestions: file-not-found (suggests `shazam_file_detail`), permission-denied, network errors, module-not-found. Added `analyzeError()` and `extractErrorText()` helper functions.

### Documentation

- **docs(OPS.md)**: add Phase 7 Kimi Code Hooks Sync checklist. Renumber Phase 7 Self-Improvement to Phase 8.

## [0.14.1] - 2026-06-21

### Features & Enhancements

- **feat: Language availability awareness** — `core/treesitter.ts` now tracks parser load status per language. `tools/overview.ts` and `hooks/before-start.ts` inject parser availability warnings into LLM context when a project uses languages whose tree-sitter grammar failed to load. Prevents "silent failures" where graph-based tools return empty for valid files.
- **refactor: Contextual parser warnings** — `getProjectParserWarnings(filePaths)` only alerts for languages the project actually uses. Pure TypeScript projects never see Dart warnings. Mixed projects only see warnings for their own unavailable languages.

### Bug Fixes

- **fix: release.sh automation** — Auto-extract CHANGELOG.md section for GitHub Release notes (replaces placeholder "See CHANGELOG for details"). Auto-delete merged remote temporary branches (Step 8.5). Added Dart to overview language list.

### Documentation

- **docs(OPS.md)**: Phase 7 Self-Improvement Retrospective — companion file audit table + process retrospective checklist. Rule: fix OPS.md gaps in the same release.

## [0.14.0] - 2026-06-21

### Features & Enhancements

- **feat(#349): Add Dart (Flutter) language support** — `.dart` extension mapping, `@sengac/tree-sitter-dart` grammar, Dart tree-sitter queries (function/class/import/call), Dart LSP server config (`dart language-server`), 12s LSP timeout. Tree-sitter grammar requires >=0.24 (graceful fallback with 0.22.4); LSP fully functional.

### Bug Fixes

- **fix(#350): Graceful handling of non-git directories** — Extension no longer crashes or pollutes UI when working directory is not a git repository. Added `core/git-utils.ts` with `isGitRepo()`, `isProjectDir()`, `safeGitExec()`. Non-project dirs (no git, no marker files) skip scanProject. Git stderr suppressed on all calls. Per-process git availability cache.

### Documentation

- **docs: README.md** — Add "100% Vibe Coding" badge (built with Pi + DeepSeek-V4-Pro). Update language count 6→7.
- **docs: AGENTS.md** — Add §9 Open Source Issue Reply Guidelines for third-party contributors. Update architecture tree (add `core/git-utils.ts`). Update language count.
- **docs: OPS.md** — Add §1.0 General .md Sync Check step.

## [0.13.2] - 2026-06-21

### Other

- **chore(#348): Bump actions/checkout from 6.0.3 to 7.0.0** — Dependabot CI workflow dependency update.
- **chore: Apply Prettier formatting** — Consistent code style across 22 source files.
- **docs: Enhance LOCAL_CI.md** — Add format check, hook verification, contract check, MCP smoke test, and Pi integration smoke test steps (13 total).
- **docs: Add OPS.md** — Release operations checklist with 17 items covering documentation sync, version bump, CI, GitHub Release, post-release verification, and cleanup.
- **docs: Update AGENTS.md** — Add OPS.md reference and expand LOCAL_CI.md description with step summary.

## [0.13.1] - 2026-06-17

### Bug Fixes

- **fix(#334): LspManager.\_shuttingDown is a one-way latch** — Reset \_shuttingDown in initializeAll() so LSP recovers after shutdown. Add 8s timeout to per-server close() in shutdown() to prevent hung-process leak.
- **fix(#335): UTF-8 boundary corruption in encoding.ts** — isValidUtf8 now treats truncated multi-byte sequences at 64KB chunk boundary as inconclusive instead of false, preventing misclassification as GBK/GB2312.
- **fix(#330): MCP shazam_verify runs sync path** — Switch to async verify (executeVerifyTextAsync/executeVerifyJsonAsync), enabling LSP diagnostics for MCP clients.
- **fix(#331): MCP silently ignores {json:true}** — Add maxTokens and json to all 14 Zod schemas; add topN bounds (min 1, max 50) to codesearch/hotspots.
- **fix(#336): codesearch hardcodes divergent skipDirs** — Replace local skipDirs sets with canonical SKIP_DIRS from core/filter.ts.

### Refactoring

- **refactor(#337): Extract core/redact.ts** — Shared SECRET_PATTERNS + redact() from mcp/tools.ts and hooks/tool-logger.ts.
- **refactor(#339): Extract core/formatters.ts** — Shared detectFormatters() from tools/fix.ts and hooks/shazam-guide.ts.
- **refactor(#340): Extract core/audit-log.ts** — Unified audit-log rotation (10MB size, 5 archived copies, 30-day age).
- **refactor(#338): Split oversized functions** — Extract helpers in tools/overview.ts (\_buildOverviewText), core/scanner.ts (\_walkDirectory), lsp/manager.ts (\_initServerForLanguage).

### Other

- **fix(#333): Batch cleanup** — Project root fixes, safety regex for combined flags, verify-state WARN handling, tree-sitter memory leak, logging improvements, documentation updates.
- **fix(#332): Definitions parity test** — Add definitions-parity.test.ts verifying TypeBox↔Zod field parity across all 14 tools.
- **fix(#341): AbortSignal not wired through** — Thread AbortSignal through initializeAll → getServerForLanguage → client.initialize. Parallelize runLspDiagnostics with Promise.allSettled.

## [0.13.0] - 2026-06-17

### Features & Enhancements

- **enhance(#327): P1 correctness batch** (#328)
  - **core/scanner**: use `statSync` (follows symlinks) instead of `lstatSync`; add symlink cycle detection via visited-realpath set
  - **core/filter**: allowlist `.github/.husky/.vscode/.claude` in `isTrackableEditedPath`
  - **tools/codesearch**: `builtinRegexSearch` now performs real regex matching with graceful literal fallback
  - **tools/overview**: use `params.project` instead of hardcoded `"."` for project root
  - **tools/definitions**: add TypeBox bounds on `depth` (1-10) and `topN` (1-50); clamp at runtime as defense-in-depth
  - **tools/fix**: validate `file` parameter does not escape project root
  - **tools/verify**: replace `execAsync(command)` with `execFileAsync(program, args)` to remove shell injection surface
  - **lsp/client**: null-check connection in `_sendRequest`, dispose `CancellationTokenSource`, track `_openedFiles` in `didClose`, remove dead `MAX_NOTIFICATIONS_PER_URI`
  - **mcp/entry**: `await shutdown()` before `process.exit(0)` in SIGTERM/SIGINT handlers
  - **hooks/issue-guard**: scope `isError` trigger to bash + `gh`/`npm test` only

### Bug Fixes

- **fix(#326): rename_symbol safety gate no longer blocks after preview** (#329)
  - Added `hooks/rename-state.ts` — session-scoped set of symbols reviewed via `shazam_call_chain`
  - `tools/call_chain.ts` records reviewed symbols on successful execution
  - `tools/rename_symbol.ts` gates `dryRun=false` on `hasCallChainChecked(symbol)` — infinite preview loop eliminated

### Refactoring

- **refactor(#324): shared bash command tokenizer** (#328)
  - New `hooks/_bash-utils.ts` with `tokenizeCommand` (now handles bash `'\''` escape) and `extractCommandFromEvent`
  - Deleted duplicate implementations in `hooks/safety.ts` and `hooks/issue-guard.ts`
  - 12 unit tests covering edge cases
- **refactor(#325): shared impact BFS** (#329)
  - Extracted `computeImpactBfs()` in `tools/impact.ts`; `graph.incoming` / `graph.outgoing` now appear exactly once
  - Text and JSON formatters share traversal output; fixed latent negative `affectedFileCount` bug
- **refactor(#327): dead-code cleanup** (#328)
  - Deleted unused exports from `core/{baseline,encoding,cache}` and dead `executeCheck`/`executeReady` from `tools/verify.ts`
  - `tools/rename_symbol.ts`: log rollback failures instead of swallowing
  - `lsp/manager.ts`: removed dead assignment
  - `mcp/tools.ts`: added inline `redact()` with secret patterns for audit log
  - Simplified `[rRfF]` regex to `[rf]` in `hooks/safety.ts` (input already lowercased)

### Other

- **docs**: AGENTS.md hooks tree synced with `hooks/_bash-utils.ts` and `hooks/rename-state.ts`
- **kimi-code plugin**: updated `mcp-reference.sh` CORE RULES to require `shazam_call_chain` before `shazam_rename_symbol`

## [0.12.0] - 2026-06-15

### Bug Fixes

- **fix(#319): core/lsp/mcp reliability** — per-URI LSP doc version, atomic cache rename with Windows fallback, scanner edge dedup and symlink handling, MCP graceful shutdown, LSP manager restart backoff with exponential delay, YAML rootMarkers fix
- **fix(#320): tool/hook safety** — write-tool dryRun defaults to true, audit log secret redaction with rotation, hook state race fixes (verify fail-closed, pre-edit timer cleanup, stop-verify flag), argv-based command detection for safety/issue-guard

### Changed

- **chore(#321): docs and schema parity** — language counts unified across README/SKILL/AGENTS (6 languages), TypeBox defaults mirror Zod, emoji removed from all source, Chinese comments translated to English, dependency versions pinned, verify→fix Next rule added

## [0.11.1] - 2026-06-15

### Bug Fixes

- **fix(#309): core/ robustness — atomic cache write, husky detection** (#317)
  - **cache**: `saveGraphCache` now writes to `.tmp` file first, then uses `renameSync` for atomic cache updates. Process crash mid-write no longer corrupts the cache.
  - **git-hooks**: `installPreCommitHook` now detects `.husky/` directory and `lefthook.yml`/`lefthook.yaml` before overwriting. Throws with user-friendly instructions when a hook manager is detected.

- **fix(#310): LSP reliability — request cancellation, async reads, adaptive timeout** (#318)
  - **lsp/client**: Added `CancellationTokenSource` for all LSP requests. On timeout, sends `$/cancelRequest` to the server. Replaced all 15 `withTimeout(sendRequest(...))` patterns with `_sendRequest(...)` helper.
  - **core/encoding**: Added `readFileAdaptiveAsync()` using `fs.promises.readFile` and `fs.promises.stat`. Same encoding fallback logic (UTF-8 → GBK → GB2312).
  - **tools/lsp_enrich**: `ensureFileOpened()` now uses async file reading. Added adaptive timeout: 10s for first request per file, 5s for subsequent.

### Skipped Findings (False Positives Verified)

- **#9 PageRank dangling mass**: Already redistributes dangling node mass uniformly
- **#8 PageRank convergence**: Already has parameterized `maxIter=50` and `tol=1e-6` with early-break
- **#19 LSP server command path**: Already has 3-tier search (project-local, PATH, user home)

## [0.11.0] - 2026-06-15

### Features & Enhancements

- **enhance(#311): tools/ safety and usability improvements** (#314)
  - **rename_symbol**: Added backup-before-write rollback mechanism — if any file write fails during rename, all already-written files are rolled back to their backup content (atomic operation)
  - **impact**: Replaced single-hop edge traversal with BFS + `--depth` parameter (default 3). Deep call chains (A→B→C→D) now correctly surface all affected files
  - **call_chain**: Added `MAX_DISPLAY_REFS = 50` automatic output truncation to prevent token explosion on heavily-referenced symbols
  - **safe_delete**: Added dynamic reference warning when zero static refs found — warns about eval(), dynamic import(), Reflect API limitations

- **enhance(#313): CI and test coverage improvements** (#316)
  - Added 26 MCP integration tests covering full scan → analyze → format pipeline using project codebase as fixture
  - Added 11 performance benchmark tests with synthetic project generation and time budgets (scanProject, PageRank, codesearch)
  - Added `integration` and `benchmark` CI jobs with appropriate timeouts

### Bug Fixes

- **fix(#312): hooks/ and entry layer fixes** (#315)
  - **before-start**: Added file count pre-check (>5000 source files → skip sync scan, return placeholder). Prevents 5-10s agent startup blocking on large projects
  - **safety**: Replaced `lower.includes()` substring matching with regex + whitespace normalization. Now catches `rm  -rf` (extra spaces), `rm -r -f` (split flags), `rm\t-rf` (tabs)
  - **shazam-guide**: Switched all 5 `execFileSync` calls to async `promisify(execFile)`. Function was declared `async` but used sync execution — now truly async
  - **index**: Added `lspManager.shutdown()` on LSP initialization timeout to clean up orphaned language server processes

### Skipped Findings (False Positives Verified)

- **#25 verify concurrency lock**: Node.js is single-threaded, no CPU contention risk from concurrent async calls
- **#48 MCP parameter validation**: Zod schemas in `definitions.ts` already validate via MCP SDK `inputSchema`
- **#27 ripgrep availability**: `codesearch.ts` already has `findRipgrep()` with fallback to builtin JS search

## [0.10.7] - 2026-06-15

### Bug Fixes

- **fix(#297): MCP LSP not initialized** (#307)
  - Call `setLspManager()` in MCP server entry so LSP enrichment works in MCP mode

- **fix(#298): rename_symbol column off-by-one + documentChanges ignored** (#307)
  - Fix `symbol.col - 1` producing -1 when `col=0` (LSP Position is already 0-based)
  - Add support for `documentChanges` format in `applyWorkspaceEdit` (LSP 3.16+)

- **fix(#299): type_hierarchy URI parsing broken on Windows/encoded paths** (#307)
  - Replace `.replace('file://', '')` with `uriToPath()` for correct URI-to-path conversion

- **fix(#300): verify JSON output hardcoded lspAvailable: false** (#307)
  - Active code path already uses `executeVerifyJsonAsync` with proper LSP diagnostics

- **fix(#301): LSP client lifecycle bugs** (#307)
  - Reset `_initPromise` after completion (allow retry after failure)
  - Clear `_openingFiles` in crash cleanup
  - Use monotonic version counter instead of `Date.now()` for `didChange`
  - Clean up SIGKILL fallback timer on process exit
  - Guard `detectWorkspaceRoot` against escaping project root
  - Close child process on initialization failure (prevent zombie processes)

- **fix(#302): Core engine bugs — tree memory leak, incremental scan, OOM risks** (#307)
  - Call `tree.delete()` to release Tree-sitter C memory after parsing
  - Add 2MB size limit to `readFileWithEncoding` (matching `readFileAdaptive`)
  - Validate visibility values during graph deserialization
  - Capture stderr in preCommit type checks for better error messages

- **fix(#303): Tools layer bugs — process.cwd(), formatting, schema** (#307)
  - `impact.ts`: convert O(n) `Array.includes()` to `Set.has()` for hot loops
  - `_factory.ts`: fix `maxTokens=0` treated as falsy (disabling truncation)

- **fix(#304): Hooks regex matching too broad + shared logic duplication + state races** (#307)
  - Add word boundaries `\b` to `SERIOUS_PATTERNS` regex
  - Use regex `gh\s+.*issue\s+create` for gh command detection (handles flags before subcommand)
  - Expand `rm` safety pattern to catch `rm -rf /home/` and `rm -rf ~/`

- **fix(#306): P2 cleanup — missing dep, cache limits, encoding optimization** (#308)
  - Add `tree-sitter-javascript` to package.json dependencies (was only transitive)
  - Add 100MB size check to cache file loading (prevent OOM from corrupted cache)
  - Add LRU eviction (max 200 entries) to `fileDetailCache`
  - Skip GBK encoding detection when UTF-8 validation succeeds
  - Validate `PROJECT_ROOT` argument in MCP server entry

### Other

- **#305**: File splitting refactor closed as "not planned" — structural preference, not a bug

## [0.10.6] - 2026-06-15

### Bug Fixes

- **fix(#295): MCP LSP init, incremental cache, log rotation, schema sync** (#296)
  - **#1**: Initialize LspManager in MCP server — LSP diagnostics, hover, type hierarchy now available in MCP mode
  - **#2**: Replace 30s TTL cache with scanProject's built-in incremental mtime detection
  - **#3**: shazam_verify and shazam_fix now have LSP support in MCP mode
  - **#4**: Add `topN` param to shazam_hotspots TypeBox schema (was MCP-only)
  - **#5**: Add `maxTokens` to shazam_codesearch Zod schema (was Pi-only)
  - **#6**: Add `json`/`maxTokens` to shazam_symbol Zod schema (was Pi-only)
  - **#8**: Add log rotation (10MB threshold, 3 archived files) to MCP logger
  - **#20**: Schema parity between Pi and MCP modes achieved

### Other

- **docs**: Update AGENTS.md, README.md, kimi-code-hooks.md to reflect MCP LSP support

## [0.10.5] - 2026-06-14

### Bug Fixes

- **fix(#289): MCP tool params silently dropped** (#294)
  - `shazam_impact`: now forwards `withSymbols` and `compact` params
  - `shazam_codesearch`: now forwards `topN` param
  - `shazam_hotspots`: now forwards `topN` param + added to Zod schema
- **fix(#292): hooks bugs** (#294)
  - `pre-edit.ts`: `_tentativeFiles` now cleaned on success
  - `issue-guard.ts`: only clears pending impact flag on success
- **fix: `execSync` → `execFileSync` in `before-start.ts`** (#294)
- **fix: biome command `format` → `check` in `shazam-guide.ts`** (#293)
- **fix: ruff detection now checks `[tool.ruff]` in pyproject.toml** (#293)
- **fix: `sudo rm -rf /` safety bypass in kimi-code hooks**
- **fix: fork bomb detection added to kimi-code hooks**

### Documentation

- **fix(#290): SKILL.md parameter docs updated for 6 tools** (#294)
- **fix(#291): docs/INSTRUCTION.md stale references fixed** (#294)
- **fix: mcp-reference.sh injection content corrected** (#293)

### Refactoring

- **fix: translate 4 Chinese comments to English** (#293)
- **fix: remove stale JSDoc in shazam-guide.ts and pre-edit.ts** (#293)

## [0.10.4] - 2026-06-14

### Security Fixes

- **fix(#286): command injection via file path in shazam-guide.ts** (#287)
  - Replaced `execSync` with `execFileSync` for all 5 formatter calls (ruff, prettier, biome, gofmt, rustfmt)
  - Prevents shell injection via malicious file paths
- **fix(#286): shell: true in tools/fix.ts formatter execution** (#287)
  - Removed `shell: true` from `execFileSync` to prevent metacharacter interpretation

### Bug Fixes

- **fix(#284): incremental scan produces incorrect graph** (#287)
  - Bug #1: `fileImports` now stores resolved file paths instead of raw module specifiers
  - Bug #2: Cross-file call-edge tracing now uses snapshot of incoming edges before `removeFileData`
  - Bug #3: Dependent file edges are cleared before rebuild to prevent duplicate accumulation
  - Bug #4: Incoming entries on targets are cleaned before deleting outgoing edges
- **fix(#285): MCP stale graph never refreshed** (#288)
  - MCP server now uses TTL-based graph cache (30s) instead of static one-time scan
- **fix(#285): verify params silently dropped in MCP** (#288)
  - Forward all 7 verify params instead of only `quick` + `lspOnly`

### Refactoring

- **fix(#286): findCalleeSymbols/findSymbolByNameInFile type safety** (#287)
  - Changed to accept `RepoGraph` directly instead of unsafe `Map→RepoGraph` cast
- **fix(#286): remove dead code in treesitter.ts** (#287)
  - Removed unreachable `_extractHtmlSymbols`/`_extractCssSymbols` methods
- **fix(#286): translate Chinese comments to English** (#287)
  - 15 Chinese comments in `core/scanner.ts` and `core/graph.ts` translated

### Other

- **fix(#286): code quality improvements** (#287)
  - Removed orphaned duplicate JSDoc block, simplified redundant condition
- **fix(#285): add missing verify params to Zod schema** (#288)

## [0.10.3] - 2026-06-14

### Bug Fixes

- **fix(#276): unify executeReady and executeReadyJson isReady logic** (#283)
  - `tools/verify.ts`: `executeReadyJson` now uses `internalOrphanCount` instead of `orphanCount` for readiness check, matching `executeReady` behavior
  - Previously, exported orphan symbols caused inconsistent READY/NOT READY results between the two functions

- **fix(#277): use nameIndex for O(1) symbol lookup** (#283)
  - `tools/symbol.ts`: `findSymbols()` now uses `graph.nameIndex.get(name)` instead of linear scan over all symbols
  - `tools/call_chain.ts`: `findSymbolsByName()` same optimization
  - Significant performance improvement for projects with large symbol counts

### Documentation

- Added Claude Code hooks reference guide (`docs/claude-code-hooks.md`)

## [0.10.2] - 2026-06-14

### Bug Fixes

- **fix(#262): move interface/type_alias orphan skip to before incoming check** (#274)
  - `core/filter.ts`: moved interface/type_alias skip to before the incoming reference check (unconditional)
  - Previous fix was inside the zero-incoming-refs block, which was never reached because interfaces get import edges

## [0.10.1] - 2026-06-14

### Bug Fixes

- **fix(#264,#266): commit gate checks verify PASS/FAIL and gives clear instructions** (#268)
  - `hooks/verify-state.ts`: added verdict tracking (PASS/FAIL) to `markVerifyCalled()`, new `hasRecentPassingVerify()` function
  - `hooks/stop-verify.ts`: extracts text from verify result content blocks for verdict parsing
  - `hooks/safety.ts`: pre-commit gate now uses `hasRecentPassingVerify()` with detailed rejection message

- **fix(#265): assessRisk uses orphan delta instead of absolute count** (#269)
  - `tools/verify.ts`: `assessRisk()` now computes orphan delta from session baseline via `diffFromBaseline()`
  - Uses `newOrphanCount` for threshold checks instead of `internalOrphans.length`
  - Falls back to absolute count when no session baseline exists

- **fix(#260,#261): exclude vendor/minified files from impact blast radius and hotspots** (#273)
  - `core/filter.ts`: added patterns for `vendor/`, `*.min.*`, `*.generated.*`, `*.bundle.*` to `NON_SOURCE_FILE_PATTERNS`
  - `tools/impact.ts`: filters `affectedFiles` with `isNonSourceFile()` in both `executeImpact()` and `executeImpactJson()`

- **fix(#267): add --direction parameter to call_chain** (#270)
  - `tools/call_chain.ts`: added `direction` parameter (`incoming`|`outgoing`|`both`, default `both`)
  - `tools/definitions.ts`, `mcp/tools.ts`: updated schemas and MCP handler

- **fix(#263): add smart tokenization fallback for natural language codesearch queries** (#272)
  - `tools/codesearch.ts`: added `mode` parameter (`literal`|`regex`|`smart`)
  - When literal search returns < 3 results and query looks like natural language, auto-falls back to tokenized regex search
  - `tools/definitions.ts`, `mcp/tools.ts`: updated schemas

- **fix(#262): exclude TypeScript interfaces and type aliases from orphan detection** (#271)
  - `core/filter.ts`: `findOrphans()` now skips `interface` and `type_alias` symbols (pure type-level, no runtime callers)

## [0.10.0] - 2026-06-14

### Features & Enhancements

- **feat(#253): add issue-guard hook** (#257)
  - New `hooks/issue-guard.ts`: detects `gh issue create` in bash commands, classifies severity (serious vs trivial), sets pending impact flag
  - New `hooks/impact-state.ts`: shared state module for impact tracking (set/clear/has/reset)

- **feat(#254): upgrade pre-edit.ts to block edits when impact is pending** (#257)
  - Modified `hooks/pre-edit.ts`: blocks `write`/`edit` tool calls when pending impact exists
  - Issue created -> edit blocked -> shazam_impact run -> edit allowed

- **feat(#255): add agent-context-guard hook** (#257)
  - New `hooks/agent-context-guard.ts`: intercepts agent-like tool calls (agent, agent_swarm, subagent)
  - Review/audit tasks with insufficient structural context are blocked
  - Coding tasks with insufficient context get a non-blocking warning
  - Short prompts (< 30 words) are skipped

### Bug Fixes

- **fix(#251): shazam_codesearch target="code" returns empty results** (#256)
  - Added `projectRoot` parameter to `executeFulltextSearch()`, passed to ripgrep as search directory
  - Added `-F` flag to ripgrep for literal string matching (no regex interpretation)
  - Moved `scanProject(".")` inside the symbol-search branch to avoid unnecessary scanning
  - Forwarded `projectRoot` from MCP `tools.ts` to `executeFulltextSearch`

- **fix(#252): shazam_verify returns 529 false positive orphan symbols for Rust** (#256)
  - Added Rust `pub` visibility detection in `_isExported` (walks AST children for `visibility_modifier` nodes)
  - Added 30 Rust standard trait names to entry point filter (From, Into, Clone, Debug, Serialize, etc.)
  - Added Rust framework function patterns to `isFrameworkHandler` (new, run, serve, from_request, etc.)
  - Skip `impl` block symbols from orphan detection (structural declarations, never called by name)

### Tests

- Added 26 new tests: full-text search with projectRoot, Rust orphan detection, impact state, issue guard, agent context guard. Full suite: 301 passed.

## [0.9.5] - 2026-06-13

### Bug Fixes

- **fix(#246): findOrphans namespace-import regression** (#250)
  - Refined side-effect skip from v0.9.4 to apply only when the importer has NO binding targeting the file. Unused internal symbols in `import * as Utils from './utils'` modules are now correctly reported.
  - Added `resolveModulePath` / `moduleMatchesFile` helpers mirroring `core/scanner.ts` `resolveImport` for specifier-to-file matching.

- **fix(#248): findOrphans Python `__all__` symbols reported as orphans** (#250)
  - Added `extractPythonAllNames` in `core/scanner.ts`. After symbol extraction for Python files, scans for top-level `__all__ = [...]` and flips listed symbols to `visibility=exported`.
  - Handles direct lists and `["a"] + ["b"]` concatenation.

- **fix(#249): findOrphans React PascalCase components in .tsx/.jsx** (#250)
  - PascalCase functions/classes in `.tsx` / `.jsx` files are now skipped (consumed via JSX, no symbol-level ref in the graph).
  - Decorator detection and DI reflection deferred (require tree-sitter parent-chain walking / LSP semantic tokens).

### Not Fixed (Documented)

- **#247**: CJS `module.exports = fn` detection deferred — requires extending tree-sitter query patterns; CJS is increasingly rare in modern ESM projects.

### Tests

- Added 3 new tests (namespace import, Python `__all__`, PascalCase React). Full suite: 274 passed (was 271).

## [0.9.4] - 2026-06-13

### Bug Fixes

- **fix(#243,#244): findOrphans skips side-effect modules and .d.ts ambient files** (#245)
  - Side-effect modules: symbols in files that appear in any other file's `fileImports` list are now excluded from orphan detection. A `import './polyfill'` creates only a file-level edge, no symbol bindings — previously all of the file's internal symbols were falsely reported as orphans.
  - `.d.ts` files: all symbols in ambient declaration files are now excluded. Tree-sitter emits them as regular `interface` / `function` / `type` with `visibility=public`, but their consumers are via global scope or type-only imports — invisible to symbol-level static analysis.

### Tests

- Added 3 new tests (side-effect skip, negative case, .d.ts skip). Full suite: 271 passed (was 268).

## [0.9.3] - 2026-06-13

### Bug Fixes

- **fix(#241): pre-commit gate shows interactive popup, orphan false positives, bash CWD mismatch, non-project edit tracking** (#242)
  - `hooks/safety.ts`: replaced `ctx.ui.select()` popup with direct auto-block for git commit without recent `shazam_verify`. Works in non-interactive (print/RPC) modes. `--no-verify` still bypasses.
  - `core/filter.ts` `findOrphans`: skip ALL exported symbols from orphan detection (consumers are external to the scanned graph). Previously only high-PageRank exports were skipped, inflating orphan counts with exported types/interfaces.
  - `hooks/before-start.ts`: use `ctx.cwd` instead of hardcoded `"."` so `generateOverviewForPrompt` scans Pi's detected project directory, not the parent.
  - `index.ts`: capture `ctx.cwd` in `before_agent_start` and update module-level `projectRoot` when it differs from `process.cwd()`.
  - `lsp/manager.ts`: added `setProjectRoot()` method for post-construction root updates.
  - `hooks/pre-edit.ts`: filter tracked paths through new `isTrackableEditedPath()` so writes to `/tmp`, `~/.pi`, `node_modules`, `dist`, `.git`, and other dot-directories do not trigger spurious verify reminders.
  - `core/filter.ts` `NON_SOURCE_FILE_PATTERNS`: tightened regexes to catch `dist/`, `build/`, `out/`, `target/` at path start.
  - Removed dead `isRegistrationFile` helper.

### Tests

- Added 25 new tests across 5 files (filter, safety, trackable-path, pre-edit-integration, lsp-manager-root). Full suite: 268 passed (was 243).

## [0.9.2] - 2026-06-12

### Features

- **feat(#235): integrate codeAction into shazam_verify** (#240)
  - When diagnostics are found, fetches LSP codeAction suggested fixes
  - Shows fix suggestions inline with error/warning messages

- **feat(#236): integrate signatureHelp into shazam_hover** (#240)
  - When position is inside a function call, shows parameter info
  - Displays active parameter with documentation

- **feat(#237): integrate implementation lookup into shazam_type_hierarchy** (#240)
  - For interface/trait types, shows implementation locations
  - Uses LSP textDocument/implementation

- **feat(#238): integrate codeLens into shazam_file_detail** (#240)
  - Shows reference counts per symbol from LSP codeLens

## [0.9.1] - 2026-06-10

### Bug Fixes

- **fix(#233): safety.ts ESM crash — require() undefined in ESM context** (#234)
  - Replaced `require("node:fs")`, `require("node:path")`, `require("node:os")` with shared `hooks/verify-state.ts` module
  - Pre-commit gate's `hasRecentVerify()` was dead code — always returned false due to caught ReferenceError

- **fix(#233): stop-verify stale reminders — edited files never cleared after verify** (#234)
  - Clear edited files tracker when `shazam_verify` succeeds
  - Reset verify flag on new post-verify edits so reminders re-trigger

- **fix(#233): divergent verify detection between safety.ts and stop-verify.ts** (#234)
  - Unified into shared `hooks/verify-state.ts` module with single source of truth

- **fix(#233): tool-logger \_starts Map never cleaned on session boundaries** (#234)
  - Added `session_start`/`session_shutdown` handlers to clear orphaned entries
  - Reset `_writeFailed` flag on successful write (was permanently disabling logging)

- **fix(#233): pre-edit path duplication — ./src/foo.ts and src/foo.ts tracked separately** (#234)
  - Added `normalizeEditedPath()` using `path.resolve()` to canonicalize paths

### Refactoring

- **refactor(#233): remove redundant clearBaseline() call in before-start.ts** (#234)
  - `createBaseline()` immediately reassigns both `_baseline` and `_previousOrphans`

- **refactor(#233): remove unnecessary optional chaining where types guarantee presence** (#234)
  - `ctx.ui.notify()` and `ctx.ui.confirm()` — both `ui` and methods are non-optional on their types

### Documentation

- **docs(#233): INSTRUCTION.md hook table listed 4 hooks, actual count is 7** (#234)
  - Added safety.ts, stop-verify.ts, failure-recovery.ts to the table
  - Fixed pre-publish grep pattern (replaced ghost `registerAfterWrite` with actual hook names)

- **docs(#233): update AGENTS.md architecture tree and event columns** (#234)
  - Added verify-state.ts to hooks architecture tree
  - Updated stop-verify event column to include `tool_result` + `tool_call` + `turn_end`

### Other

- **docs(#233): fix stale JSDoc in shazam-guide.ts** (#234)
  - Updated tool_call descriptions to match current implementation

- **docs(#233): document handler ordering contract for before_agent_start** (#234)
  - Added comments in index.ts and before-start.ts explaining required registration order

## [0.9.0] - 2026-06-10

### Features & Enhancements

- **feat(#229): add JavaScript file support to tree-sitter parsing** (#232)
  - Added `.js`, `.jsx`, `.mjs`, `.cjs` to `EXT_TO_LANG` extension map
  - Load `tree-sitter-javascript` grammar on initialization
  - JavaScript queries already defined in `core/treesitter-queries.ts`
  - `tree-sitter-javascript` v0.23.1 available as transitive dependency of `tree-sitter-typescript`

### Bug Fixes

- **fix(#228): visibility detection broken — all symbols marked as "public"** (#232)
  - Replaced `defCap.includes("export")` with AST ancestor traversal (`_isExported` helper)
  - Checks if any ancestor node type includes "export" (e.g., `export_statement`)
  - Exported TS/JS functions, classes, and interfaces now correctly marked as `visibility: "exported"`
  - Fixes orphan detection filters that rely on `sym.visibility === "exported"`

- **fix(#230): pre-commit hook shows [object Object] instead of option labels** (#232)
  - Replaced `{label, description}` objects with plain strings in `ctx.ui.select()` call
  - Pi runtime's `toString()` on objects produces `[object Object]` instead of the label

### Documentation

- **docs(#231): improve README architecture diagram and AGENTS.md compliance checklist** (#232)
  - Updated README architecture diagram to show clearer layering (hooks → tools → core/lsp)
  - Added missing modules: `baseline.ts`, `filter.ts`, `git-hooks.ts`, `output.ts`, `treesitter-queries.ts`, `definitions.ts`
  - Added JavaScript to language support list and file format table
  - Added Pre-Commit Checklist to AGENTS.md covering all critical verification steps

## [0.8.0] - 2026-06-10

### Bug Fixes

- **fix(#226): worktree-aware git diff in shazam_verify** (#227)
  - Added `resolveGitWorkdir()` helper using `git rev-parse --show-toplevel` to detect worktree root
  - Updated `getGitChangedFiles()` to resolve correct git working directory before running `git diff`
  - Fixed sync `executeVerify()` using hardcoded `"."` instead of `projectRoot` parameter
  - `shazam_verify` now correctly detects file changes when running from a git worktree
  - Risk level now based on actual worktree changes instead of main repo pre-existing state
  - Added 6 comprehensive worktree tests covering main repo, worktree, and cross-directory scenarios

## [0.7.1] - 2026-06-09

### Bug Fixes

- **fix: use memory-based verify tracking in stop-verify hook**
  - Changed from audit log file checking to in-memory tracking for more reliable `shazam_verify` detection
  - Eliminated file system race conditions in the stop-verify hook

## [0.7.0] - 2026-06-09

### Features

- **feat: add safety hooks, auto-format, stop-verify, and failure-recovery**
  - `hooks/safety.ts`: Destructive command confirmation dialog + Pre-commit gate
    - Interactive confirmation for dangerous commands (rm -rf, dd, mkfs, etc.)
    - Blocks git commit if shazam_verify was not run recently
    - Uses Pi's ctx.ui.confirm() and ctx.ui.select() for user interaction
  - `hooks/stop-verify.ts`: Turn-end verification reminder
    - Checks if there were unverified file edits when turn ends
    - Sends reminder to run shazam_verify before finishing
  - `hooks/failure-recovery.ts`: Consecutive failure detection
    - Tracks failure patterns per tool
    - After 3 failures: suggests alternative approaches
    - After 5 failures: suggests reorienting with shazam_overview
    - Prevents LLM loops
  - `hooks/shazam-guide.ts`: Auto-format feature
    - Detects file type and runs native formatter (ruff, prettier, gofmt, rustfmt, biome)
    - Falls back to suggesting shazam_fix if no native formatter found
    - Shows notification after formatting

### Documentation

- Updated AGENTS.md with new hooks table and architecture
- Updated docs/kimi-code-hooks.md with Pi vs Kimi-Code comparison

## [0.6.3] - 2026-06-08

### Bug Fixes

- **fix(#212): make find_tests test patterns language-aware** (#219)
  - Added `getTestPatternForLanguage()` returning language-specific regex for Python, Go, Rust, Java, C#, and JS/TS
  - Updated `tools/definitions.ts` to document all supported conventions

- **fix(#214): detect ruff, rustfmt, gofmt in shazam_fix** (#221)
  - Added ruff detection via `pyproject.toml`/`ruff.toml`
  - Added rustfmt detection via `Cargo.toml`/`rustfmt.toml`
  - Added gofmt detection via `go.mod`
  - Added language-aware recommended fix commands

- **fix(#215): add Python/Rust/Go dependency detection to overview** (#222)
  - Added `buildPythonDepsSection()` reading `pyproject.toml`/`requirements.txt`
  - Added `buildRustDepsSection()` reading `Cargo.toml`
  - Added `buildGoDepsSection()` reading `go.mod`
  - Updated JSON envelope with new dependency fields

- **fix(#216): show graph references when LSP unavailable in rename_symbol** (#223)
  - Collects all matching symbols instead of first match
  - Shows detailed graph reference listing when LSP is unavailable
  - Suggests `shazam_call_chain` for manual verification

- **fix(#217): add language-specific entry point detection to orphan filter** (#224)
  - Added `isEntryPointSymbol()` for Python dunders, Rust main/Default/Drop, Go main/init
  - Added `isFrameworkHandler()` for route handlers and middleware patterns
  - Extended test file detection beyond JS patterns

### Features & Enhancements

- **enhance(#213): extract React context and custom hook symbols** (#220)
  - Added `variable_declarator` + `call_expression` tree-sitter pattern
  - Captures `createContext(...)`, `create...(...)`, and `use[A-Z]` custom hooks

- **enhance(#218): make hotspots exclusion message language-aware** (#225)
  - Added `getExcludeMessage()` helper detecting JS/TS, Python, Rust, Go project types
  - Python projects now see language-appropriate exclusion list

## [0.6.2] - 2026-06-08

### Enhancements

- **enhance: shazam_fix notification after edits** — Pi hook now reminds LLM to run auto-formatting (prettier/ruff/gofmt/rustfmt) after every write/edit operation

## [0.6.1] - 2026-06-08

### Bug Fixes

- **fix(#209): rename_symbol crash** — customExecute now scans project directly instead of relying on module-level graph variable (#211)
- **fix(#210): type_hierarchy interface lookup** — Added interface/type_alias/enum patterns to TypeScript tree-sitter queries (#211)

## [0.6.0] - 2026-06-08

### Features & Enhancements

- **enhance(#199): shazam_impact output now includes symbol-level detail, test discovery, and risk assessment** (#207)
  - Added risk assessment based on affected file and symbol counts (low/medium/high)
  - Added symbol grouping by file with upstream/downstream direction
  - Added automatic test discovery for target files using `shazam_find_tests`
  - Enhanced output format with better structure and information density

### Bug Fixes

- **fix(#196,#200): shazam_find_tests sourceFile and module parameters now search project-root test directories** (#204)
  - Fixed `sourceFile` parameter to search `tests/`, `test/`, `__test__/` directories at project root
  - Fixed `module` parameter by including files with 0 symbols in graph (e.g., test files with no exports)
  - Both `--sourceFile core/scanner.ts` and `--module scanner` now correctly find `tests/scanner.test.ts`

- **fix(#198): shazam_verify orphan detection now distinguishes internal and exported symbols** (#206)
  - `findOrphans()` returns structured result with separate lists for internal and exported orphans
  - Risk assessment now only counts internal orphans (exported orphans are informational)
  - Output clearly separates "Internal (likely dead code)" and "Exported (may be used externally)"

### Refactoring

- **refactor(#197): reduce shazam-guide hook noise — remove redundant notifications** (#205)
  - Removed write/edit success notification (LLM already knows about `shazam_verify` from SKILL.md)
  - Removed search/grep/find notification (LLM already knows about `shazam_codesearch` from SKILL.md)
  - Removed `shazam_verify` PASS notification (LLM already sees the verify result)
  - Removed `shazam_file_detail` notification (not all files have tests)
  - Kept valuable notifications: symbol with 5+ callers, verify FAIL/WARN, multi-file edit, impact/rename safety reminders

- **refactor(#203): unify Pi and MCP tool definitions** (#208)
  - Created `tools/definitions.ts` with shared tool definitions (single source of truth)
  - Updated `mcp/tools.ts` to use shared definitions for descriptions and parameter schemas
  - Both Pi and MCP now use the same descriptions and parameter schemas

### Other

- **fix: use @latest for local installations to avoid version locking**
  - Changed `pi install npm:pi-shazam@0.5.5` to `pi install npm:pi-shazam@latest`

## [0.5.5] - 2026-06-08

### Bug Fixes

- **fix: use @latest for local installations to avoid version locking**
  - Changed `pi install npm:pi-shazam@0.5.5` to `pi install npm:pi-shazam@latest`

## [0.5.4] - 2026-06-08

### Features & Enhancements

- **feat(#202): report supported languages in overview output** (#202)
  - Added language support section to overview output
  - Shows supported languages with file counts
  - Updated SKILL.md with correct language count

## [0.5.3] - 2026-06-07

### Refactoring

- **refactor: reduce language support to Python, TypeScript, Go, Rust, JSON**
  - Removed support for less common languages to reduce complexity
  - Updated documentation to reflect new language support

## [0.5.2] - 2026-06-07

### Bug Fixes

- **fix(#195): append shazam overview to system prompt instead of replacing it** (#201)
  - Fixed issue where shazam overview was replacing the entire system prompt
  - Now correctly appends to the existing system prompt

## [0.5.1] - 2026-06-07

### Bug Fixes

- **fix(#193): show error output in pre-commit hook checks** (#194)
  - Fixed issue where pre-commit hook errors were not being displayed
  - Now shows full error output for debugging

## [0.5.0] - 2026-06-07

### Features & Enhancements

- **perf(#191): add nameIndex and targetToSources indexes to RepoGraph** (#192)
  - Added O(1) lookup indexes for symbol names and edge targets
  - Significant performance improvement for large projects

- **fix(#189): race conditions, type safety, and resource cleanup** (#190)
  - Fixed race conditions in concurrent graph operations
  - Improved type safety throughout the codebase
  - Added proper resource cleanup for LSP connections

### Refactoring

- **fix(#177,#179,#180): tools, hooks, MCP, and index cleanup** (#188)
  - Cleaned up tool registration code
  - Improved hook implementations
  - Better MCP server structure
  - Simplified index.ts

- **fix(#167,#170,#172): LSP discriminated union, module cleanup, and verify diagnostics fixes** (#187)
  - Fixed LSP type definitions with discriminated unions
  - Cleaned up module exports
  - Improved verify diagnostics accuracy

## [0.4.0] - 2026-06-06

### Features & Enhancements

- Initial public release
- Core analysis engine with tree-sitter parsing
- 14 language support (Python, TypeScript, Go, Rust, JSON, etc.)
- LSP integration for type information
- MCP server for non-Pi clients
- Pi extension with 14 analysis tools
- Graph-based dependency analysis
- PageRank-based file importance scoring
- Incremental scanning with persistent caching
