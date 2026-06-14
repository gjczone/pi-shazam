# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
